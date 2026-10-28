import { describe, expect, it } from 'vitest';
import { workspaceWithMember } from './helpers';

type Agent = Awaited<ReturnType<typeof workspaceWithMember>>['owner']['agent'];

async function post(agent: Agent, channelId: string, content: string) {
  const res = await agent.post(`/api/channels/${channelId}/messages`).send({ content });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.message as { id: string; content: string; createdAt: string };
}

async function channels(agent: Agent, workspaceId: string) {
  const res = await agent.get(`/api/workspaces/${workspaceId}/channels`);
  return res.body.items as { id: string; name: string; isMember: boolean; unreadCount: number; isPrivate: boolean }[];
}

describe('channels', () => {
  it('validates and normalises channel names', async () => {
    const { owner, workspace } = await workspaceWithMember();
    const url = `/api/workspaces/${workspace.id}/channels`;

    const created = await owner.agent.post(url).send({ name: '  Ürün Fikirleri ' });
    expect(created.status).toBe(201);
    expect(created.body.channel.name).toBe('ürün-fikirleri');

    const dup = await owner.agent.post(url).send({ name: 'ürün-fikirleri' });
    expect(dup.status).toBe(400);
    const bad = await owner.agent.post(url).send({ name: 'no/slashes' });
    expect(bad.body.error.details[0].path).toBe('name');
  });

  it('keeps private channels invisible to non-members until they are added', async () => {
    const { owner, member, workspace } = await workspaceWithMember();
    const created = await owner.agent
      .post(`/api/workspaces/${workspace.id}/channels`)
      .send({ name: 'secret', isPrivate: true });
    const secretId = created.body.channel.id as string;
    await post(owner.agent, secretId, 'top secret plan');

    expect((await channels(member.agent, workspace.id)).map((c) => c.name)).toEqual(['general']);
    expect((await member.agent.get(`/api/channels/${secretId}/messages`)).status).toBe(404);
    expect((await member.agent.post(`/api/channels/${secretId}/join`)).status).toBe(404);
    const search = await member.agent.get(`/api/workspaces/${workspace.id}/search?q=secret`);
    expect(search.body.items).toHaveLength(0);

    const add = await owner.agent.post(`/api/channels/${secretId}/members`).send({ userId: member.user.id });
    expect(add.status).toBe(201);
    expect((await channels(member.agent, workspace.id)).map((c) => c.name)).toEqual(['general', 'secret']);
    expect((await member.agent.get(`/api/channels/${secretId}/messages`)).body.items).toHaveLength(1);
  });

  it('requires joining a public channel before posting, and keeps everyone in #general', async () => {
    const { owner, member, workspace, generalId } = await workspaceWithMember();
    const created = await owner.agent.post(`/api/workspaces/${workspace.id}/channels`).send({ name: 'random' });
    const randomId = created.body.channel.id as string;

    // Visible and readable, but not writable until joined.
    expect((await member.agent.get(`/api/channels/${randomId}/messages`)).status).toBe(200);
    const blocked = await member.agent.post(`/api/channels/${randomId}/messages`).send({ content: 'hi' });
    expect(blocked.status).toBe(403);

    expect((await member.agent.post(`/api/channels/${randomId}/join`)).status).toBe(200);
    await post(member.agent, randomId, 'hi');
    expect((await member.agent.post(`/api/channels/${randomId}/leave`)).status).toBe(200);
    expect((await member.agent.post(`/api/channels/${generalId}/leave`)).status).toBe(400);
  });

  it('lets only admins delete channels, and never #general', async () => {
    const { owner, member, workspace, generalId } = await workspaceWithMember();
    const created = await member.agent.post(`/api/workspaces/${workspace.id}/channels`).send({ name: 'temp' });
    const id = created.body.channel.id as string;

    expect((await member.agent.delete(`/api/channels/${id}`)).status).toBe(403);
    // The creator may rename it, though.
    expect((await member.agent.patch(`/api/channels/${id}`).send({ topic: 'Short-lived' })).status).toBe(200);
    expect((await owner.agent.delete(`/api/channels/${generalId}`)).status).toBe(400);
    expect((await owner.agent.delete(`/api/channels/${id}`)).status).toBe(204);
  });
});

describe('messages', () => {
  it('pages through history newest-first without gaps or duplicates', async () => {
    const { owner, generalId } = await workspaceWithMember();
    for (let i = 1; i <= 7; i++) await post(owner.agent, generalId, `message ${i}`);

    const seen: string[] = [];
    let before: string | undefined;
    for (;;) {
      const res = await owner.agent.get(`/api/channels/${generalId}/messages`).query({ limit: 3, before });
      const items = res.body.items as { id: string; content: string }[];
      seen.unshift(...items.map((m) => m.content));
      if (!res.body.hasMore) break;
      before = items[0]!.id;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7].map((i) => `message ${i}`));
  });

  it('lets authors edit, and authors or admins delete', async () => {
    const { owner, member, generalId } = await workspaceWithMember();
    const mine = await post(member.agent, generalId, 'typo hre');
    const theirs = await post(owner.agent, generalId, 'owner message');

    const edit = await member.agent.patch(`/api/messages/${mine.id}`).send({ content: 'typo here' });
    expect(edit.body.message).toMatchObject({ content: 'typo here', editedAt: expect.any(String) });
    expect((await member.agent.patch(`/api/messages/${theirs.id}`).send({ content: 'hacked' })).status).toBe(403);
    expect((await member.agent.delete(`/api/messages/${theirs.id}`)).status).toBe(403);
    // Admins moderate.
    expect((await owner.agent.delete(`/api/messages/${mine.id}`)).status).toBe(204);
  });

  it('rejects empty and oversized messages', async () => {
    const { owner, generalId } = await workspaceWithMember();
    expect((await owner.agent.post(`/api/channels/${generalId}/messages`).send({ content: '   ' })).status).toBe(400);
    const long = 'x'.repeat(4001);
    expect((await owner.agent.post(`/api/channels/${generalId}/messages`).send({ content: long })).status).toBe(400);
  });

  it('counts unread messages from others and moves the read pointer only forward', async () => {
    const { owner, member, workspace, generalId } = await workspaceWithMember();
    const first = await post(owner.agent, generalId, 'one');
    await post(owner.agent, generalId, 'two');
    const third = await post(owner.agent, generalId, 'three');
    await post(member.agent, generalId, 'my own message does not count');

    // Posting marks the channel read up to the member's own message.
    const unreadAfterPost = (await channels(member.agent, workspace.id)).find((c) => c.id === generalId)!;
    expect(unreadAfterPost.unreadCount).toBe(0);
    await post(owner.agent, generalId, 'four');
    expect((await channels(member.agent, workspace.id)).find((c) => c.id === generalId)!.unreadCount).toBe(1);

    // Moving backwards is ignored.
    const back = await member.agent.post(`/api/channels/${generalId}/read`).send({ messageId: first.id });
    expect(back.body.moved).toBe(false);

    const page = await owner.agent.get(`/api/channels/${generalId}/messages`);
    const pointer = page.body.readPointers.find((p: { userId: string }) => p.userId === member.user.id);
    expect(new Date(pointer.at).getTime()).toBeGreaterThan(new Date(third.createdAt).getTime());
  });

  it('searches visible messages case-insensitively and treats % and _ literally', async () => {
    const { owner, member, workspace, generalId } = await workspaceWithMember();
    await post(owner.agent, generalId, 'Deploy is DONE');
    await post(owner.agent, generalId, '100% coverage');
    await post(owner.agent, generalId, 'snake_case names');
    await post(owner.agent, generalId, 'nothing here');

    const search = (q: string) => member.agent.get(`/api/workspaces/${workspace.id}/search`).query({ q });
    expect((await search('deploy is')).body.items.map((m: { content: string }) => m.content)).toEqual([
      'Deploy is DONE',
    ]);
    expect((await search('0%')).body.items).toHaveLength(1);
    expect((await search('e_c')).body.items).toHaveLength(1);
    expect((await search('x')).status).toBe(400);
    expect((await search('deploy')).body.items[0].channel.name).toBe('general');
  });
});
