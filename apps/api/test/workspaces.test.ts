import { describe, expect, it } from 'vitest';
import { createWorkspace, signedInAgent, workspaceWithMember } from './helpers';

describe('auth', () => {
  it('registers, reads the session and issues WebSocket tickets that are not access tokens', async () => {
    const { agent } = await signedInAgent('Ada');
    const me = await agent.get('/api/auth/me');
    expect(me.body.user.name).toBe('Ada');

    const { body } = await agent.post('/api/realtime/ticket');
    expect(typeof body.ticket).toBe('string');
    // A ticket must not work as a bearer token for the REST API.
    const misuse = await agent.get('/api/auth/me').set('Authorization', `Bearer ${body.ticket}`).set('Cookie', '');
    expect(misuse.status).toBe(401);
  });
});

describe('workspaces', () => {
  it('creates a workspace with #general and the creator as owner', async () => {
    const { agent } = await signedInAgent();
    const { workspace } = await createWorkspace(agent, 'Çay Ocağı');

    const list = await agent.get('/api/workspaces');
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ name: 'Çay Ocağı', role: 'OWNER' });
    expect(list.body.items[0].slug).toMatch(/^cay-ocagi-[a-f0-9]{6}$/);
    expect(list.body.items[0].inviteCode).toBe(workspace.inviteCode);

    const channels = await agent.get(`/api/workspaces/${workspace.id}/channels`);
    expect(channels.body.items).toEqual([expect.objectContaining({ name: 'general', isMember: true, memberCount: 1 })]);
  });

  it('joins by invite code into #general, and hides the code from regular members', async () => {
    const { member, workspace, generalId } = await workspaceWithMember();

    const ws = await member.agent.get(`/api/workspaces/${workspace.id}`);
    expect(ws.body.workspace.role).toBe('MEMBER');
    expect(ws.body.workspace.inviteCode).toBeUndefined();

    const channels = await member.agent.get(`/api/workspaces/${workspace.id}/channels`);
    expect(channels.body.items.find((c: { id: string }) => c.id === generalId).isMember).toBe(true);

    // Joining twice is harmless.
    const again = await member.agent.post('/api/workspaces/join').send({ inviteCode: workspace.inviteCode });
    expect(again.status).toBe(200);
  });

  it('rejects unknown invite codes and rotates codes', async () => {
    const { owner, workspace } = await workspaceWithMember();
    const outsider = await signedInAgent();

    const bad = await outsider.agent.post('/api/workspaces/join').send({ inviteCode: 'nope' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details[0].path).toBe('inviteCode');

    const rotated = await owner.agent.post(`/api/workspaces/${workspace.id}/invite-code`);
    expect(rotated.body.inviteCode).not.toBe(workspace.inviteCode);
    const old = await outsider.agent.post('/api/workspaces/join').send({ inviteCode: workspace.inviteCode });
    expect(old.status).toBe(400);
  });

  it('hides workspaces from non-members', async () => {
    const { workspace } = await workspaceWithMember();
    const outsider = await signedInAgent();
    for (const path of ['', '/channels', '/members', '/search?q=hello']) {
      const res = await outsider.agent.get(`/api/workspaces/${workspace.id}${path}`);
      expect(res.status, path).toBe(404);
    }
  });

  it('enforces roles for managing members', async () => {
    const { owner, member, workspace } = await workspaceWithMember();
    const third = await signedInAgent('Third');
    await third.agent.post('/api/workspaces/join').send({ inviteCode: workspace.inviteCode });

    // Members cannot remove others or change roles.
    expect((await member.agent.delete(`/api/workspaces/${workspace.id}/members/${third.user.id}`)).status).toBe(403);
    expect(
      (await member.agent.patch(`/api/workspaces/${workspace.id}/members/${third.user.id}`).send({ role: 'ADMIN' }))
        .status,
    ).toBe(403);

    // The owner promotes; the new admin can remove a member but not the owner.
    const promote = await owner.agent
      .patch(`/api/workspaces/${workspace.id}/members/${member.user.id}`)
      .send({ role: 'ADMIN' });
    expect(promote.status).toBe(200);
    expect((await member.agent.delete(`/api/workspaces/${workspace.id}/members/${owner.user.id}`)).status).toBe(409);
    expect((await member.agent.delete(`/api/workspaces/${workspace.id}/members/${third.user.id}`)).status).toBe(204);
    expect((await third.agent.get(`/api/workspaces/${workspace.id}`)).status).toBe(404);

    // The owner cannot leave; members can.
    expect((await owner.agent.delete(`/api/workspaces/${workspace.id}/members/${owner.user.id}`)).status).toBe(409);
    expect((await member.agent.delete(`/api/workspaces/${workspace.id}/members/${member.user.id}`)).status).toBe(204);
  });

  it('lets only the owner delete the workspace', async () => {
    const { owner, member, workspace } = await workspaceWithMember();
    expect((await member.agent.delete(`/api/workspaces/${workspace.id}`)).status).toBe(403);
    expect((await owner.agent.delete(`/api/workspaces/${workspace.id}`)).status).toBe(204);
    expect((await owner.agent.get('/api/workspaces')).body.items).toHaveLength(0);
  });
});
