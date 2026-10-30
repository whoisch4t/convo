import type { Message, ReadPointer } from '@convo/shared';
import { badRequest, notFound } from '../lib/errors';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { storage } from '../lib/storage';
import { publish, topics } from '../realtime';
import { forbidden, isManager, requireChannelAccess, requireChannelMember } from './access';
import { attachmentSelect, toAttachment } from './attachments.service';
import { markNotificationsRead, notifyMentions } from './notifications.service';

export const messageSelect = {
  id: true,
  channelId: true,
  content: true,
  createdAt: true,
  editedAt: true,
  author: { select: { id: true, name: true } },
  attachments: { select: attachmentSelect, orderBy: { createdAt: 'asc' } },
} as const;

/** Prisma returns Dates; the wire format uses ISO strings. */
type Row = { id: string; channelId: string; content: string; createdAt: Date; editedAt: Date | null } & {
  author: { id: string; name: string };
  attachments: { id: string; name: string; mimeType: string; size: number }[];
};
export const toMessage = (m: Row): Message => ({
  ...m,
  createdAt: m.createdAt.toISOString(),
  editedAt: m.editedAt?.toISOString() ?? null,
  attachments: m.attachments.map(toAttachment),
});

/** Used by both the REST endpoint and the WebSocket `message.send` event. */
export async function createMessage(userId: string, channelId: string, content: string, attachmentIds: string[] = []) {
  const { channel } = await requireChannelMember(userId, channelId);
  const fileIds = [...new Set(attachmentIds)];
  if (!content && fileIds.length === 0) {
    throw badRequest('Message cannot be empty', [{ path: 'content', message: 'Message cannot be empty' }]);
  }

  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({ data: { channelId, authorId: userId, content }, select: { id: true } });
    if (fileIds.length > 0) {
      // Only the sender's own pending uploads to this channel can be attached, and only once.
      const { count } = await tx.attachment.updateMany({
        where: { id: { in: fileIds }, uploaderId: userId, channelId, messageId: null },
        data: { messageId: created.id },
      });
      if (count !== fileIds.length) throw badRequest('A file is missing or was already sent');
    }
    return tx.message.findUniqueOrThrow({ where: { id: created.id }, select: messageSelect });
  });

  const message = toMessage(row);
  publish(topics.channel(channelId), { type: 'message.created', message });
  await notifyMentions(channel, message);
  // Sending a message means you have read the channel up to it.
  await markRead(userId, channelId, message.id, { skipAccessCheck: true });
  return message;
}

export async function updateMessage(userId: string, messageId: string, content: string) {
  const existing = await prisma.message.findUnique({
    where: { id: messageId },
    select: { authorId: true, channelId: true },
  });
  if (!existing) throw notFound('Message');
  const { channel } = await requireChannelAccess(userId, existing.channelId);
  if (existing.authorId !== userId) throw forbidden('You can only edit your own messages');

  const message = toMessage(
    await prisma.message.update({
      where: { id: messageId },
      data: { content, editedAt: new Date() },
      select: messageSelect,
    }),
  );
  publish(topics.channel(message.channelId), { type: 'message.updated', message });
  // People added in the edit get notified; people already notified do not get a second one.
  await notifyMentions(channel, message);
  return message;
}

export async function deleteMessage(userId: string, messageId: string) {
  const existing = await prisma.message.findUnique({
    where: { id: messageId },
    select: { authorId: true, channelId: true, attachments: { select: { storageKey: true } } },
  });
  if (!existing) throw notFound('Message');
  const { role } = await requireChannelAccess(userId, existing.channelId);
  if (existing.authorId !== userId && !isManager(role)) {
    throw forbidden('Only the author or a workspace admin can delete this message');
  }
  await prisma.message.delete({ where: { id: messageId } });
  publish(topics.channel(existing.channelId), {
    type: 'message.deleted',
    channelId: existing.channelId,
    messageId,
  });
  // The rows are gone with the message. If removing a file fails, the upload sweep retries later.
  await Promise.all(
    existing.attachments.map(({ storageKey }) =>
      storage.delete(storageKey).catch((err) => logger.warn({ err, storageKey }, 'Could not delete file')),
    ),
  );
}

/**
 * Moves the member's read pointer to `messageId`, never backwards.
 * Returns the new pointer, or null when it did not move.
 */
export async function markRead(
  userId: string,
  channelId: string,
  messageId: string,
  { skipAccessCheck = false } = {},
): Promise<ReadPointer | null> {
  if (!skipAccessCheck) await requireChannelMember(userId, channelId);
  const message = await prisma.message.findFirst({
    where: { id: messageId, channelId },
    select: { createdAt: true },
  });
  if (!message) throw notFound('Message');

  // The condition in WHERE makes this safe when two tabs mark different messages at once.
  const { count } = await prisma.channelMember.updateMany({
    where: {
      channelId,
      userId,
      OR: [{ lastReadAt: null }, { lastReadAt: { lt: message.createdAt } }],
    },
    data: { lastReadAt: message.createdAt, lastReadMessageId: messageId },
  });
  if (count === 0) return null;

  const pointer: ReadPointer = { userId, messageId, at: message.createdAt.toISOString() };
  publish(topics.channel(channelId), { type: 'read', channelId, ...pointer });
  // Having read the channel this far, mentions up to here are no longer news.
  await markNotificationsRead(userId, { channelId, message: { createdAt: { lte: message.createdAt } } });
  return pointer;
}
