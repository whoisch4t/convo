import type { Message, ReadPointer } from '@convo/shared';
import { notFound } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { publish, topics } from '../realtime';
import { forbidden, isManager, requireChannelAccess, requireChannelMember } from './access';

export const messageSelect = {
  id: true,
  channelId: true,
  content: true,
  createdAt: true,
  editedAt: true,
  author: { select: { id: true, name: true } },
} as const;

/** Prisma returns Dates; the wire format uses ISO strings. */
type Row = { id: string; channelId: string; content: string; createdAt: Date; editedAt: Date | null } & {
  author: { id: string; name: string };
};
export const toMessage = (m: Row): Message => ({
  ...m,
  createdAt: m.createdAt.toISOString(),
  editedAt: m.editedAt?.toISOString() ?? null,
});

/** Used by both the REST endpoint and the WebSocket `message.send` event. */
export async function createMessage(userId: string, channelId: string, content: string) {
  await requireChannelMember(userId, channelId);
  const row = await prisma.message.create({
    data: { channelId, authorId: userId, content },
    select: messageSelect,
  });
  const message = toMessage(row);
  publish(topics.channel(channelId), { type: 'message.created', message });
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
  await requireChannelAccess(userId, existing.channelId);
  if (existing.authorId !== userId) throw forbidden('You can only edit your own messages');

  const message = toMessage(
    await prisma.message.update({
      where: { id: messageId },
      data: { content, editedAt: new Date() },
      select: messageSelect,
    }),
  );
  publish(topics.channel(message.channelId), { type: 'message.updated', message });
  return message;
}

export async function deleteMessage(userId: string, messageId: string) {
  const existing = await prisma.message.findUnique({
    where: { id: messageId },
    select: { authorId: true, channelId: true },
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
  return pointer;
}
