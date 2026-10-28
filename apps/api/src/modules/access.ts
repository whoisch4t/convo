import { MANAGER_ROLES, type WorkspaceRole } from '@convo/shared';
import { HttpError, notFound } from '../lib/errors';
import { prisma } from '../lib/prisma';

export const forbidden = (message = 'You do not have permission to do that') =>
  new HttpError(403, 'FORBIDDEN', message);

export const isManager = (role: WorkspaceRole) => MANAGER_ROLES.includes(role);

/** Throws 404 (not 403) for non-members, so workspace ids cannot be probed. */
export async function requireWorkspaceMember(userId: string, workspaceId: string) {
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  if (!member) throw notFound('Workspace');
  return member.role;
}

export async function requireWorkspaceManager(userId: string, workspaceId: string) {
  const role = await requireWorkspaceMember(userId, workspaceId);
  if (!isManager(role)) throw forbidden('Only workspace owners and admins can do that');
  return role;
}

export interface ChannelAccess {
  channel: { id: string; workspaceId: string; name: string; isPrivate: boolean; createdById: string | null };
  role: WorkspaceRole;
  isMember: boolean;
}

/**
 * Who can see a channel: workspace members for public channels, channel members for private ones.
 * Anything else gets 404 so private channels stay invisible.
 */
export async function requireChannelAccess(userId: string, channelId: string): Promise<ChannelAccess> {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: {
      id: true,
      workspaceId: true,
      name: true,
      isPrivate: true,
      createdById: true,
      workspace: { select: { members: { where: { userId }, select: { role: true } } } },
      members: { where: { userId }, select: { userId: true } },
    },
  });
  const role = channel?.workspace.members[0]?.role;
  if (!channel || !role) throw notFound('Channel');
  const isMember = channel.members.length > 0;
  if (channel.isPrivate && !isMember) throw notFound('Channel');
  const { workspace: _w, members: _m, ...rest } = channel;
  return { channel: rest, role, isMember };
}

/** Posting, reading receipts and typing need channel membership, not just visibility. */
export async function requireChannelMember(userId: string, channelId: string) {
  const access = await requireChannelAccess(userId, channelId);
  if (!access.isMember) throw forbidden('Join the channel first');
  return access;
}
