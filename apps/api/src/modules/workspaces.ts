import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import {
  channelCreateSchema,
  joinWorkspaceSchema,
  memberRoleSchema,
  searchQuerySchema,
  workspaceCreateSchema,
  type SearchResult,
} from '@convo/shared';
import { badRequest, conflict, notFound } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { currentUserId } from '../middleware/auth';
import { parse } from '../middleware/validate';
import { publish, topics } from '../realtime';
import { forbidden, isManager, requireWorkspaceManager, requireWorkspaceMember } from './access';
import { addChannelMember, announceChannel, listChannels, removeChannelMember } from './channels.service';
import { messageSelect, toMessage } from './messages.service';

const newInviteCode = () => randomBytes(9).toString('base64url');

function slugify(name: string) {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${base || 'workspace'}-${randomBytes(3).toString('hex')}`;
}

export const workspacesRouter = Router();

workspacesRouter.get('/', async (req, res) => {
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId: currentUserId(req) },
    select: { role: true, workspace: true },
    orderBy: { joinedAt: 'asc' },
  });
  res.json({
    items: memberships.map(({ role, workspace: { inviteCode, ...w } }) => ({
      ...w,
      role,
      ...(isManager(role) ? { inviteCode } : {}),
    })),
  });
});

workspacesRouter.post('/', async (req, res) => {
  const userId = currentUserId(req);
  const { name } = parse(workspaceCreateSchema, req.body);
  const workspace = await prisma.workspace.create({
    data: {
      name,
      slug: slugify(name),
      inviteCode: newInviteCode(),
      members: { create: { userId, role: 'OWNER' } },
      // Every workspace starts with #general, which new members join automatically.
      channels: {
        create: {
          name: 'general',
          topic: 'Company-wide announcements and chat',
          createdById: userId,
          members: { create: { userId } },
        },
      },
    },
  });
  res.status(201).json({ workspace: { ...workspace, role: 'OWNER' } });
});

workspacesRouter.post('/join', async (req, res) => {
  const userId = currentUserId(req);
  const { inviteCode } = parse(joinWorkspaceSchema, req.body);
  const workspace = await prisma.workspace.findUnique({ where: { inviteCode } });
  if (!workspace) throw badRequest('Validation failed', [{ path: 'inviteCode', message: 'Invite code is not valid' }]);

  const { inviteCode: _code, ...publicWorkspace } = workspace;
  const created = await prisma.workspaceMember.createMany({
    data: [{ workspaceId: workspace.id, userId, role: 'MEMBER' }],
    skipDuplicates: true,
  });
  if (created.count > 0) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, name: true } });
    publish(topics.workspace(workspace.id), { type: 'workspace.member.joined', workspaceId: workspace.id, user });
    const general = await prisma.channel.findFirst({
      where: { workspaceId: workspace.id, name: 'general', isPrivate: false },
      select: { id: true },
    });
    if (general) await addChannelMember(general.id, workspace.id, user);
  }
  const { role } = await prisma.workspaceMember.findUniqueOrThrow({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId } },
  });
  res.status(created.count > 0 ? 201 : 200).json({ workspace: { ...publicWorkspace, role } });
});

workspacesRouter.get('/:id', async (req, res) => {
  const role = await requireWorkspaceMember(currentUserId(req), req.params.id);
  const { inviteCode, ...workspace } = await prisma.workspace.findUniqueOrThrow({ where: { id: req.params.id } });
  res.json({ workspace: { ...workspace, role, ...(isManager(role) ? { inviteCode } : {}) } });
});

workspacesRouter.patch('/:id', async (req, res) => {
  await requireWorkspaceManager(currentUserId(req), req.params.id);
  const { name } = parse(workspaceCreateSchema, req.body);
  const workspace = await prisma.workspace.update({ where: { id: req.params.id }, data: { name } });
  res.json({ workspace });
});

workspacesRouter.delete('/:id', async (req, res) => {
  const role = await requireWorkspaceMember(currentUserId(req), req.params.id);
  if (role !== 'OWNER') throw forbidden('Only the owner can delete a workspace');
  await prisma.workspace.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

workspacesRouter.post('/:id/invite-code', async (req, res) => {
  await requireWorkspaceManager(currentUserId(req), req.params.id);
  const { inviteCode } = await prisma.workspace.update({
    where: { id: req.params.id },
    data: { inviteCode: newInviteCode() },
  });
  res.json({ inviteCode });
});

// ---------- Members ----------

workspacesRouter.get('/:id/members', async (req, res) => {
  await requireWorkspaceMember(currentUserId(req), req.params.id);
  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId: req.params.id },
    select: { role: true, joinedAt: true, user: { select: { id: true, name: true, email: true } } },
    orderBy: { user: { name: 'asc' } },
  });
  res.json({ items: members });
});

workspacesRouter.patch('/:id/members/:userId', async (req, res) => {
  const actorId = currentUserId(req);
  const actorRole = await requireWorkspaceMember(actorId, req.params.id);
  if (actorRole !== 'OWNER') throw forbidden('Only the owner can change roles');
  const { role } = parse(memberRoleSchema, req.body);
  if (role === 'OWNER') throw badRequest('There can only be one owner');
  if (req.params.userId === actorId) throw badRequest('You cannot change your own role');

  const { count } = await prisma.workspaceMember.updateMany({
    where: { workspaceId: req.params.id, userId: req.params.userId },
    data: { role },
  });
  if (count === 0) throw notFound('Member');
  res.json({ role });
});

/** Leave (your own id) or remove someone (owners and admins; nobody can remove the owner). */
workspacesRouter.delete('/:id/members/:userId', async (req, res) => {
  const actorId = currentUserId(req);
  const workspaceId = req.params.id;
  const targetId = req.params.userId;
  const actorRole = await requireWorkspaceMember(actorId, workspaceId);
  const target = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: targetId } },
  });
  if (!target) throw notFound('Member');
  if (target.role === 'OWNER') throw conflict('The owner cannot leave. Delete the workspace instead.');
  if (targetId !== actorId && !isManager(actorRole)) throw forbidden('Only owners and admins can remove members');
  if (targetId !== actorId && target.role === 'ADMIN' && actorRole !== 'OWNER') {
    throw forbidden('Only the owner can remove an admin');
  }

  const channels = await prisma.channelMember.findMany({
    where: { userId: targetId, channel: { workspaceId } },
    select: { channelId: true },
  });
  for (const { channelId } of channels) await removeChannelMember(channelId, workspaceId, targetId);
  await prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId, userId: targetId } } });
  publish(topics.workspace(workspaceId), { type: 'workspace.member.left', workspaceId, userId: targetId });
  // The removed user is no longer on the workspace topic, so tell them directly too.
  publish(topics.user(targetId), { type: 'workspace.member.left', workspaceId, userId: targetId });
  res.status(204).end();
});

// ---------- Channels ----------

workspacesRouter.get('/:id/channels', async (req, res) => {
  const userId = currentUserId(req);
  await requireWorkspaceMember(userId, req.params.id);
  res.json({ items: await listChannels(userId, req.params.id) });
});

workspacesRouter.post('/:id/channels', async (req, res) => {
  const userId = currentUserId(req);
  const workspaceId = req.params.id;
  await requireWorkspaceMember(userId, workspaceId);
  const input = parse(channelCreateSchema, req.body);

  const exists = await prisma.channel.findUnique({
    where: { workspaceId_name: { workspaceId, name: input.name } },
    select: { id: true },
  });
  if (exists)
    throw badRequest('Validation failed', [{ path: 'name', message: 'A channel with this name already exists' }]);

  const channel = await prisma.channel.create({
    data: { ...input, workspaceId, createdById: userId, members: { create: { userId } } },
    select: { id: true },
  });
  await announceChannel('channel.created', channel.id);
  publish(topics.user(userId), { type: 'channel.access', workspaceId, channelId: channel.id, granted: true });
  const created = (await listChannels(userId, workspaceId)).find((c) => c.id === channel.id);
  res.status(201).json({ channel: created });
});

// ---------- Search ----------

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

workspacesRouter.get('/:id/search', async (req, res) => {
  const userId = currentUserId(req);
  const workspaceId = req.params.id;
  await requireWorkspaceMember(userId, workspaceId);
  const { q, channelId, limit } = parse(searchQuerySchema, req.query);

  const rows = await prisma.message.findMany({
    where: {
      content: { contains: escapeLike(q), mode: 'insensitive' },
      channel: {
        workspaceId,
        ...(channelId ? { id: channelId } : {}),
        // Only channels the user can see.
        OR: [{ isPrivate: false }, { members: { some: { userId } } }],
      },
    },
    select: { ...messageSelect, channel: { select: { id: true, name: true } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
  });
  const items: SearchResult[] = rows.map(({ channel, ...m }) => ({ ...toMessage(m), channel }));
  res.json({ items });
});
