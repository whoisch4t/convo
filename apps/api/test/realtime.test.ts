import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signedInAgent, workspaceWithMember } from './helpers';
import { startNode, TestSocket, upgradeStatus, type TestNode } from './realtime-helpers';

let nodeA: TestNode;
let nodeB: TestNode;

beforeAll(async () => {
  nodeA = await startNode();
  nodeB = await startNode();
});

afterAll(async () => {
  await nodeA.close();
  await nodeB.close();
});

describe('connecting', () => {
  it('refuses missing or forged tickets, foreign origins and unknown paths', async () => {
    const { agent } = await signedInAgent();
    const { body } = await agent.post('/api/realtime/ticket');

    expect(await upgradeStatus(nodeA.wsUrl)).toBe(401);
    expect(await upgradeStatus(`${nodeA.wsUrl}?ticket=forged`)).toBe(401);
    expect(await upgradeStatus(`${nodeA.wsUrl}?ticket=${body.ticket}`, { Origin: 'https://evil.example' })).toBe(403);
    expect(await upgradeStatus(nodeA.wsUrl.replace('/ws', '/other'))).toBe(404);
    expect(await upgradeStatus(`${nodeA.wsUrl}?ticket=${body.ticket}`, { Origin: 'http://localhost:3200' })).toBe(101);
    // Single use: the same ticket cannot open a second socket.
    expect(await upgradeStatus(`${nodeA.wsUrl}?ticket=${body.ticket}`, { Origin: 'http://localhost:3200' })).toBe(401);
  });

  it('validates frames and answers pings', async () => {
    const { agent } = await signedInAgent();
    const socket = await TestSocket.connect(nodeA, agent);

    socket.ws.send('not json');
    expect((await socket.next('error')).code).toBe('BAD_REQUEST');
    socket.send({ type: 'does.not.exist' });
    expect((await socket.next('error')).code).toBe('BAD_REQUEST');
    socket.send({ type: 'ping' });
    await socket.next('pong');
    await socket.close();
  });

  it('does not let users subscribe to workspaces they are not in', async () => {
    const { workspace } = await workspaceWithMember();
    const outsider = await signedInAgent();
    const socket = await TestSocket.connect(nodeA, outsider.agent);
    socket.send({ type: 'workspace.subscribe', workspaceId: workspace.id });
    expect((await socket.next('error')).code).toBe('NOT_FOUND');
    await socket.close();
  });
});

describe('messaging', () => {
  it('acks the sender and delivers to members on another instance', async () => {
    const { owner, member, workspace, generalId } = await workspaceWithMember();
    const alice = await TestSocket.connect(nodeA, owner.agent);
    const bob = await TestSocket.connect(nodeB, member.agent);
    await alice.subscribe(workspace.id);
    await bob.subscribe(workspace.id);

    alice.send({ type: 'message.send', channelId: generalId, content: 'Merhaba 👋', clientId: 'c1' });
    const ack = await alice.next('message.ack');
    expect(ack.clientId).toBe('c1');
    expect(ack.message).toMatchObject({ content: 'Merhaba 👋', author: { id: owner.user.id, name: 'Owner' } });

    const received = await bob.next('message.created');
    expect(received.message.id).toBe(ack.message.id);

    // REST writes are broadcast too.
    const edited = await owner.agent.patch(`/api/messages/${ack.message.id}`).send({ content: 'Merhaba!' });
    expect(edited.status).toBe(200);
    expect((await bob.next('message.updated')).message.content).toBe('Merhaba!');
    await owner.agent.delete(`/api/messages/${ack.message.id}`);
    expect((await bob.next('message.deleted')).messageId).toBe(ack.message.id);

    await Promise.all([alice.close(), bob.close()]);
  });

  it('returns errors with the clientId when a message is rejected', async () => {
    const { owner, workspace } = await workspaceWithMember();
    const created = await owner.agent.post(`/api/workspaces/${workspace.id}/channels`).send({ name: 'random' });
    const outsiderOfChannel = await signedInAgent();
    await outsiderOfChannel.agent.post('/api/workspaces/join').send({ inviteCode: workspace.inviteCode });

    const socket = await TestSocket.connect(nodeA, outsiderOfChannel.agent);
    await socket.subscribe(workspace.id);
    socket.send({ type: 'message.send', channelId: created.body.channel.id, content: 'hi', clientId: 'c9' });
    expect(await socket.next('error')).toMatchObject({ code: 'FORBIDDEN', clientId: 'c9' });
    socket.send({
      type: 'message.send',
      channelId: created.body.channel.id,
      content: 'x'.repeat(5000),
      clientId: 'c10',
    });
    expect(await socket.next('error')).toMatchObject({ code: 'BAD_REQUEST', clientId: 'c10' });
    await socket.close();
  });

  it('lets non-members watch a focused public channel', async () => {
    const { owner, member, workspace } = await workspaceWithMember();
    const created = await owner.agent.post(`/api/workspaces/${workspace.id}/channels`).send({ name: 'announcements' });
    const channelId = created.body.channel.id as string;

    const bob = await TestSocket.connect(nodeB, member.agent);
    await bob.subscribe(workspace.id);
    bob.send({ type: 'channel.focus', channelId });
    bob.send({ type: 'ping' });
    await bob.next('pong'); // frames run in order, so focus is applied by now

    await owner.agent.post(`/api/channels/${channelId}/messages`).send({ content: 'Big news' });
    expect((await bob.next('message.created')).message.content).toBe('Big news');

    bob.send({ type: 'channel.focus', channelId: null });
    bob.send({ type: 'ping' });
    await bob.next('pong');
    await owner.agent.post(`/api/channels/${channelId}/messages`).send({ content: 'More news' });
    await bob.expectNone('message.created');
    await bob.close();
  });
});

describe('typing and read receipts', () => {
  it('broadcasts typing to the channel, throttled per sender', async () => {
    const { owner, member, workspace, generalId } = await workspaceWithMember();
    const alice = await TestSocket.connect(nodeA, owner.agent);
    const bob = await TestSocket.connect(nodeB, member.agent);
    await alice.subscribe(workspace.id);
    await bob.subscribe(workspace.id);

    alice.send({ type: 'typing', channelId: generalId });
    alice.send({ type: 'typing', channelId: generalId });
    const typing = await bob.next('typing');
    expect(typing).toMatchObject({ channelId: generalId, user: { id: owner.user.id, name: 'Owner' } });
    await bob.expectNone('typing');

    await Promise.all([alice.close(), bob.close()]);
  });

  it('broadcasts read pointers when a member reads a message', async () => {
    const { owner, member, workspace, generalId } = await workspaceWithMember();
    const alice = await TestSocket.connect(nodeA, owner.agent);
    const bob = await TestSocket.connect(nodeB, member.agent);
    await alice.subscribe(workspace.id);
    await bob.subscribe(workspace.id);

    alice.send({ type: 'message.send', channelId: generalId, content: 'Did you see this?', clientId: 'r1' });
    const { message } = await alice.next('message.ack');
    await bob.next('message.created');

    bob.send({ type: 'read', channelId: generalId, messageId: message.id });
    const read = await alice.next('read', (e) => e.userId === member.user.id);
    expect(read).toMatchObject({ channelId: generalId, messageId: message.id, at: message.createdAt });

    // Reading the same message again does not broadcast anything.
    bob.send({ type: 'read', channelId: generalId, messageId: message.id });
    await alice.expectNone('read', (e) => e.userId === member.user.id);
    await Promise.all([alice.close(), bob.close()]);
  });
});

describe('presence', () => {
  it('reports online in the snapshot and announces offline only after the last tab closes', async () => {
    const { owner, member, workspace } = await workspaceWithMember();
    const alice = await TestSocket.connect(nodeA, owner.agent);
    await alice.subscribe(workspace.id);

    const bobTab1 = await TestSocket.connect(nodeB, member.agent);
    expect(await alice.next('presence', (e) => e.userId === member.user.id)).toMatchObject({ status: 'online' });
    const bobTab2 = await TestSocket.connect(nodeA, member.agent);

    const snapshot = await bobTab1.subscribe(workspace.id);
    expect(snapshot.online.sort()).toEqual([owner.user.id, member.user.id].sort());

    await bobTab1.close();
    await alice.expectNone('presence');
    await bobTab2.close();
    expect(await alice.next('presence', (e) => e.userId === member.user.id)).toMatchObject({ status: 'offline' });
    await alice.close();
  });
});

describe('access changes', () => {
  it('starts streaming a private channel as soon as someone is added', async () => {
    const { owner, member, workspace } = await workspaceWithMember();
    const bob = await TestSocket.connect(nodeB, member.agent);
    await bob.subscribe(workspace.id);

    const created = await owner.agent
      .post(`/api/workspaces/${workspace.id}/channels`)
      .send({ name: 'leadership', isPrivate: true });
    const channelId = created.body.channel.id as string;
    // Private channels are not announced to the whole workspace.
    await bob.expectNone('channel.created');

    await owner.agent.post(`/api/channels/${channelId}/members`).send({ userId: member.user.id });
    expect(await bob.next('channel.access')).toMatchObject({ channelId, granted: true });
    expect((await bob.next('channel.created')).channel.name).toBe('leadership');

    await owner.agent.post(`/api/channels/${channelId}/messages`).send({ content: 'Welcome aboard' });
    expect((await bob.next('message.created')).message.content).toBe('Welcome aboard');
    await bob.close();
  });

  it('stops streaming to people removed from the workspace', async () => {
    const { owner, member, workspace, generalId } = await workspaceWithMember();
    const bob = await TestSocket.connect(nodeB, member.agent);
    await bob.subscribe(workspace.id);

    await owner.agent.delete(`/api/workspaces/${workspace.id}/members/${member.user.id}`);
    await bob.next('workspace.member.left', (e) => e.userId === member.user.id);

    await owner.agent.post(`/api/channels/${generalId}/messages`).send({ content: 'after kick' });
    await bob.expectNone('message.created');
    await bob.close();
  });
});
