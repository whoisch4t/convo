import { Router, type Request } from 'express';
import {
  attachmentUploadQuerySchema,
  channelAddMemberSchema,
  channelUpdateSchema,
  messageCreateSchema,
  messageListQuerySchema,
  readSchema,
  type MessagePage,
} from '@convo/shared';
import { env } from '../env';
import { badRequest, HttpError, notFound } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { currentUserId } from '../middleware/auth';
import { rateLimit } from '../middleware/rate-limit';
import { parse } from '../middleware/validate';
import { publish, topics } from '../realtime';
import { forbidden, isManager, requireChannelAccess, requireChannelMember } from './access';
import { uploadAttachment } from './attachments.service';
import { addChannelMember, announceChannel, removeChannelMember } from './channels.service';
import { createMessage, markRead, messageSelect, toMessage } from './messages.service';

export const channelsRouter = Router();

channelsRouter.get('/:id', async (req, res) => {
  const userId = currentUserId(req);
  const { isMember } = await requireChannelAccess(userId, req.params.id);
  const channel = await prisma.channel.findUniqueOrThrow({
    where: { id: req.params.id },
    select: { id: true, workspaceId: true, name: true, topic: true, isPrivate: true, createdAt: true },
  });
  res.json({ channel: { ...channel, isMember } });
});

/** Rename or change the topic: the creator, or a workspace owner/admin. */
channelsRouter.patch('/:id', async (req, res) => {
  const userId = currentUserId(req);
  const { channel, role } = await requireChannelAccess(userId, req.params.id);
  if (channel.createdById !== userId && !isManager(role)) {
    throw forbidden('Only the channel creator or an admin can edit this channel');
  }
  const input = parse(channelUpdateSchema, req.body);
  if (channel.name === 'general' && input.name && input.name !== 'general') {
    throw badRequest('Validation failed', [{ path: 'name', message: '#general cannot be renamed' }]);
  }
  if (input.name && input.name !== channel.name) {
    const taken = await prisma.channel.findUnique({
      where: { workspaceId_name: { workspaceId: channel.workspaceId, name: input.name } },
      select: { id: true },
    });
    if (taken)
      throw badRequest('Validation failed', [{ path: 'name', message: 'A channel with this name already exists' }]);
  }
  await prisma.channel.update({ where: { id: channel.id }, data: input });
  await announceChannel('channel.updated', channel.id);
  res.json({ ok: true });
});

channelsRouter.delete('/:id', async (req, res) => {
  const userId = currentUserId(req);
  const { channel, role } = await requireChannelAccess(userId, req.params.id);
  if (!isManager(role)) throw forbidden('Only workspace owners and admins can delete channels');
  if (channel.name === 'general') throw badRequest('#general cannot be deleted');

  const members = await prisma.channelMember.findMany({ where: { channelId: channel.id }, select: { userId: true } });
  await prisma.channel.delete({ where: { id: channel.id } });
  const event = { type: 'channel.deleted', workspaceId: channel.workspaceId, channelId: channel.id } as const;
  if (channel.isPrivate) {
    for (const m of members) publish(topics.user(m.userId), event);
  } else {
    publish(topics.workspace(channel.workspaceId), event);
  }
  res.status(204).end();
});

// ---------- Membership ----------

channelsRouter.post('/:id/join', async (req, res) => {
  const userId = currentUserId(req);
  const { channel } = await requireChannelAccess(userId, req.params.id);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, name: true } });
  await addChannelMember(channel.id, channel.workspaceId, user);
  res.json({ ok: true });
});

channelsRouter.post('/:id/leave', async (req, res) => {
  const userId = currentUserId(req);
  const { channel, isMember } = await requireChannelAccess(userId, req.params.id);
  if (!isMember) throw badRequest('You are not in this channel');
  if (channel.name === 'general' && !channel.isPrivate) throw badRequest('Everyone stays in #general');
  await removeChannelMember(channel.id, channel.workspaceId, userId);
  res.json({ ok: true });
});

channelsRouter.get('/:id/members', async (req, res) => {
  await requireChannelAccess(currentUserId(req), req.params.id);
  const members = await prisma.channelMember.findMany({
    where: { channelId: req.params.id },
    select: { joinedAt: true, user: { select: { id: true, name: true } } },
    orderBy: { user: { name: 'asc' } },
  });
  res.json({ items: members });
});

/** Any channel member can add other workspace members (that is how people get into private channels). */
channelsRouter.post('/:id/members', async (req, res) => {
  const userId = currentUserId(req);
  const { channel } = await requireChannelMember(userId, req.params.id);
  const { userId: targetId } = parse(channelAddMemberSchema, req.body);
  const target = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: channel.workspaceId, userId: targetId } },
    select: { user: { select: { id: true, name: true } } },
  });
  if (!target) throw badRequest('Validation failed', [{ path: 'userId', message: 'Not a member of this workspace' }]);
  const added = await addChannelMember(channel.id, channel.workspaceId, target.user);
  // Private channels were invisible to the new member until now.
  if (added && channel.isPrivate) await announceChannel('channel.created', channel.id);
  res.status(added ? 201 : 200).json({ ok: true });
});

channelsRouter.delete('/:id/members/:userId', async (req, res) => {
  const userId = currentUserId(req);
  const { channel, role } = await requireChannelAccess(userId, req.params.id);
  if (req.params.userId !== userId && !isManager(role)) throw forbidden('Only owners and admins can remove people');
  if (channel.name === 'general' && !channel.isPrivate) throw badRequest('Everyone stays in #general');
  const removed = await removeChannelMember(channel.id, channel.workspaceId, req.params.userId);
  if (!removed) throw notFound('Member');
  res.status(204).end();
});

// ---------- Messages ----------

channelsRouter.get('/:id/messages', async (req, res) => {
  const userId = currentUserId(req);
  const { channel } = await requireChannelAccess(userId, req.params.id);
  const { before, limit } = parse(messageListQuerySchema, req.query);

  let cursor: { createdAt: Date; id: string } | null = null;
  if (before) {
    cursor = await prisma.message.findFirst({
      where: { id: before, channelId: channel.id },
      select: { createdAt: true, id: true },
    });
    if (!cursor) throw badRequest('Validation failed', [{ path: 'before', message: 'Unknown message' }]);
  }

  // Keyset pagination on (createdAt, id): stable even when new messages arrive meanwhile.
  const rows = await prisma.message.findMany({
    where: {
      channelId: channel.id,
      ...(cursor
        ? {
            OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }],
          }
        : {}),
    },
    select: messageSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const pointers = await prisma.channelMember.findMany({
    where: { channelId: channel.id, lastReadMessageId: { not: null } },
    select: { userId: true, lastReadMessageId: true, lastReadAt: true },
  });

  const page: MessagePage = {
    // Oldest first, the order they are displayed in.
    items: rows.slice(0, limit).reverse().map(toMessage),
    hasMore,
    readPointers: pointers.map((p) => ({
      userId: p.userId,
      messageId: p.lastReadMessageId!,
      at: p.lastReadAt!.toISOString(),
    })),
  };
  res.json(page);
});

channelsRouter.post('/:id/messages', async (req, res) => {
  const { content, attachmentIds } = parse(messageCreateSchema, req.body);
  const message = await createMessage(currentUserId(req), req.params.id, content, attachmentIds);
  res.status(201).json({ message });
});

const uploadLimiter = rateLimit({
  name: 'upload',
  windowMs: 60_000,
  max: env.NODE_ENV === 'test' ? 10_000 : 30,
  key: currentUserId,
});

// The body is the raw file. application/octet-stream is not a "simple" content type, so a
// cross-site page cannot send it without a CORS preflight: the same CSRF guard as JSON writes.
channelsRouter.post('/:id/attachments', uploadLimiter, async (req: Request<{ id: string }>, res) => {
  if (!req.is('application/octet-stream')) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the file as application/octet-stream');
  }
  const { name, type } = parse(attachmentUploadQuerySchema, req.query);
  const length = req.get('content-length');
  const attachment = await uploadAttachment(currentUserId(req), req.params.id, req, {
    name,
    type,
    contentLength: length ? Number(length) : undefined,
  });
  res.status(201).json({ attachment });
});

channelsRouter.post('/:id/read', async (req, res) => {
  const { messageId } = parse(readSchema, req.body);
  const pointer = await markRead(currentUserId(req), req.params.id, messageId);
  res.json({ moved: pointer !== null });
});
