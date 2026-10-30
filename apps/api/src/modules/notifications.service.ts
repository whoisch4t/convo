import { mentionedUserIds, type AppNotification, type Message } from '@convo/shared';
import { prisma, type Prisma } from '../lib/prisma';
import { publish, topics } from '../realtime';
import { requireWorkspaceMember } from './access';

const EXCERPT_LENGTH = 200;
const excerpt = (content: string) =>
  content.length > EXCERPT_LENGTH ? `${content.slice(0, EXCERPT_LENGTH - 1)}…` : content;

interface ChannelRef {
  id: string;
  workspaceId: string;
  name: string;
  isPrivate: boolean;
}

/**
 * Notifies everyone mentioned in `message` who can see the channel: channel members for private
 * channels, workspace members for public ones. Safe to call again after an edit: the unique
 * (userId, messageId) index means only newly mentioned people get a notification.
 */
export async function notifyMentions(channel: ChannelRef, message: Message) {
  const ids = mentionedUserIds(message.content).filter((id) => id !== message.author.id);
  if (ids.length === 0) return;

  const allowed = channel.isPrivate
    ? await prisma.channelMember.findMany({
        where: { channelId: channel.id, userId: { in: ids } },
        select: { userId: true },
      })
    : await prisma.workspaceMember.findMany({
        where: { workspaceId: channel.workspaceId, userId: { in: ids } },
        select: { userId: true },
      });
  if (allowed.length === 0) return;

  const created = await prisma.notification.createManyAndReturn({
    data: allowed.map(({ userId }) => ({
      userId,
      actorId: message.author.id,
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      messageId: message.id,
    })),
    skipDuplicates: true,
    select: { id: true, userId: true, createdAt: true },
  });

  for (const n of created) {
    const notification: AppNotification = {
      id: n.id,
      type: 'mention',
      createdAt: n.createdAt.toISOString(),
      readAt: null,
      workspaceId: channel.workspaceId,
      actor: message.author,
      channel: { id: channel.id, name: channel.name },
      message: { id: message.id, content: excerpt(message.content) },
    };
    publish(topics.user(n.userId), { type: 'notification.created', notification });
  }
}

export async function listNotifications(userId: string, workspaceId: string, limit: number) {
  await requireWorkspaceMember(userId, workspaceId);
  const where = { userId, workspaceId };
  const [rows, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        createdAt: true,
        readAt: true,
        workspaceId: true,
        actor: { select: { id: true, name: true } },
        channel: { select: { id: true, name: true } },
        message: { select: { id: true, content: true } },
      },
    }),
    prisma.notification.count({ where: { ...where, readAt: null } }),
  ]);
  const items: AppNotification[] = rows.map((n) => ({
    ...n,
    type: 'mention',
    createdAt: n.createdAt.toISOString(),
    readAt: n.readAt?.toISOString() ?? null,
    message: { id: n.message.id, content: excerpt(n.message.content) },
  }));
  return { items, unreadCount };
}

/** Marks matching unread notifications read and tells the user's other tabs. Returns the ids. */
export async function markNotificationsRead(userId: string, where: Prisma.NotificationWhereInput) {
  const unread = await prisma.notification.findMany({
    where: { ...where, userId, readAt: null },
    select: { id: true },
  });
  if (unread.length === 0) return [];
  const ids = unread.map((n) => n.id);
  await prisma.notification.updateMany({ where: { id: { in: ids } }, data: { readAt: new Date() } });
  publish(topics.user(userId), { type: 'notification.read', ids });
  return ids;
}
