import type { Channel } from '@convo/shared';
import { prisma, Prisma } from '../lib/prisma';
import { publish, topics } from '../realtime';

export const channelSelect = {
  id: true,
  workspaceId: true,
  name: true,
  topic: true,
  isPrivate: true,
  createdAt: true,
  _count: { select: { members: true } },
} as const;

type ChannelRow = Prisma.ChannelGetPayload<{ select: typeof channelSelect }>;
export type ChannelEventShape = Omit<Channel, 'isMember' | 'unreadCount'>;

export const toChannelEvent = ({ _count, createdAt, ...c }: ChannelRow): ChannelEventShape => ({
  ...c,
  createdAt: createdAt.toISOString(),
  memberCount: _count.members,
});

/** Channels the user can see in a workspace, with membership and unread counts. */
export async function listChannels(userId: string, workspaceId: string): Promise<Channel[]> {
  const rows = await prisma.channel.findMany({
    where: { workspaceId, OR: [{ isPrivate: false }, { members: { some: { userId } } }] },
    select: { ...channelSelect, members: { where: { userId }, select: { userId: true } } },
    orderBy: { name: 'asc' },
  });
  const joined = rows.filter((r) => r.members.length > 0).map((r) => r.id);
  const unread = await unreadCounts(userId, joined);
  return rows.map(({ members, ...row }) => ({
    ...toChannelEvent(row),
    isMember: members.length > 0,
    unreadCount: unread.get(row.id) ?? 0,
  }));
}

/** Messages from other people newer than the read pointer (or the join time, for new members). */
export async function unreadCounts(userId: string, channelIds: string[]) {
  if (channelIds.length === 0) return new Map<string, number>();
  const rows = await prisma.$queryRaw<{ channelId: string; unread: number }[]>`
    SELECT cm."channelId", COUNT(m.id)::int AS unread
    FROM "ChannelMember" cm
    JOIN "Message" m
      ON m."channelId" = cm."channelId"
     AND m."createdAt" > COALESCE(cm."lastReadAt", cm."joinedAt")
     AND m."authorId" <> cm."userId"
    WHERE cm."userId" = ${userId} AND cm."channelId" IN (${Prisma.join(channelIds)})
    GROUP BY cm."channelId"`;
  return new Map(rows.map((r) => [r.channelId, r.unread]));
}

/**
 * Announces a channel change. Public channels are announced to the whole workspace;
 * private ones only to their members, so their names never leak.
 */
export async function announceChannel(type: 'channel.created' | 'channel.updated', channelId: string) {
  const row = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { ...channelSelect, members: { select: { userId: true } } },
  });
  if (!row) return;
  const { members, ...rest } = row;
  const channel = toChannelEvent(rest);
  if (!channel.isPrivate) {
    publish(topics.workspace(channel.workspaceId), { type, channel });
  } else {
    for (const m of members) publish(topics.user(m.userId), { type, channel });
  }
}

/** Adds a user to a channel and tells their sockets to start listening to it. */
export async function addChannelMember(channelId: string, workspaceId: string, user: { id: string; name: string }) {
  const result = await prisma.channelMember.createMany({
    data: [{ channelId, userId: user.id }],
    skipDuplicates: true,
  });
  if (result.count === 0) return false;
  publish(topics.channel(channelId), { type: 'channel.member.joined', channelId, user });
  publish(topics.user(user.id), { type: 'channel.access', workspaceId, channelId, granted: true });
  return true;
}

export async function removeChannelMember(channelId: string, workspaceId: string, userId: string) {
  const { count } = await prisma.channelMember.deleteMany({ where: { channelId, userId } });
  if (count === 0) return false;
  publish(topics.channel(channelId), { type: 'channel.member.left', channelId, userId });
  publish(topics.user(userId), { type: 'channel.access', workspaceId, channelId, granted: false });
  return true;
}
