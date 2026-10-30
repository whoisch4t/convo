import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mentionToken, type NotificationList } from '@convo/shared';
import { signedInAgent, workspaceWithMember } from './helpers';
import { startNode, TestSocket, type TestNode } from './realtime-helpers';

type Agent = Awaited<ReturnType<typeof signedInAgent>>['agent'];

const say = (agent: Agent, channelId: string, content: string) =>
  agent.post(`/api/channels/${channelId}/messages`).send({ content });

async function inbox(agent: Agent, workspaceId: string) {
  const res = await agent.get('/api/notifications').query({ workspaceId });
  return res.body as NotificationList;
}

let node: TestNode;
beforeAll(async () => {
  node = await startNode();
});
afterAll(async () => {
  await node.close();
});

describe('mentions', () => {
  it('notifies the mentioned member, never the author or people outside the workspace', async () => {
    const { owner, member, workspace, generalId } = await workspaceWithMember();
    const outsider = await signedInAgent('Outsider');

    const content = `Hey ${mentionToken(member.user.id)}, ${mentionToken(owner.user.id)} and ${mentionToken(outsider.user.id)}`;
    const sent = await say(owner.agent, generalId, content);
    expect(sent.status).toBe(201);

    const list = await inbox(member.agent, workspace.id);
    expect(list.unreadCount).toBe(1);
    expect(list.items[0]).toMatchObject({
      type: 'mention',
      readAt: null,
      actor: { id: owner.user.id, name: 'Owner' },
      channel: { id: generalId, name: 'general' },
      message: { id: sent.body.message.id, content },
    });
    expect((await inbox(owner.agent, workspace.id)).items).toHaveLength(0);
    expect((await outsider.agent.get('/api/notifications').query({ workspaceId: workspace.id })).status).toBe(404);
  });

  it('does not notify workspace members about private channels they are not in', async () => {
    const { owner, member, workspace } = await workspaceWithMember();
    const { body } = await owner.agent
      .post(`/api/workspaces/${workspace.id}/channels`)
      .send({ name: 'secret', isPrivate: true });

    await say(owner.agent, body.channel.id, `${mentionToken(member.user.id)} you cannot see this`);
    expect((await inbox(member.agent, workspace.id)).items).toHaveLength(0);
  });

  it('notifies people added in an edit exactly once', async () => {
    const { owner, member, workspace, generalId } = await workspaceWithMember();
    const sent = await say(owner.agent, generalId, 'Who can review this?');
    const id = sent.body.message.id as string;

    await owner.agent.patch(`/api/messages/${id}`).send({ content: `${mentionToken(member.user.id)} can you?` });
    await owner.agent.patch(`/api/messages/${id}`).send({ content: `${mentionToken(member.user.id)} can you please?` });
    expect((await inbox(member.agent, workspace.id)).items).toHaveLength(1);
  });

  it('removes notifications together with their message', async () => {
    const { owner, member, workspace, generalId } = await workspaceWithMember();
    const sent = await say(owner.agent, generalId, `${mentionToken(member.user.id)} oops`);
    await owner.agent.delete(`/api/messages/${sent.body.message.id}`).expect(204);
    expect((await inbox(member.agent, workspace.id)).items).toHaveLength(0);
  });
});

describe('reading notifications', () => {
  it('marks chosen notifications or all of them read', async () => {
    const { owner, member, workspace, generalId } = await workspaceWithMember();
    await say(owner.agent, generalId, `${mentionToken(member.user.id)} one`);
    await say(owner.agent, generalId, `${mentionToken(member.user.id)} two`);
    const [newest] = (await inbox(member.agent, workspace.id)).items;

    const one = await member.agent
      .post('/api/notifications/read')
      .send({ workspaceId: workspace.id, ids: [newest!.id] });
    expect(one.body.ids).toEqual([newest!.id]);
    expect((await inbox(member.agent, workspace.id)).unreadCount).toBe(1);

    await member.agent.post('/api/notifications/read').send({ workspaceId: workspace.id });
    const after = await inbox(member.agent, workspace.id);
    expect(after.unreadCount).toBe(0);
    expect(after.items.every((n) => n.readAt !== null)).toBe(true);
  });

  it('clears mentions once the channel has been read past them', async () => {
    const { owner, member, workspace, generalId } = await workspaceWithMember();
    const first = await say(owner.agent, generalId, `${mentionToken(member.user.id)} first`);
    const second = await say(owner.agent, generalId, `${mentionToken(member.user.id)} second`);

    await member.agent.post(`/api/channels/${generalId}/read`).send({ messageId: first.body.message.id });
    const list = await inbox(member.agent, workspace.id);
    expect(list.unreadCount).toBe(1);
    expect(list.items.find((n) => n.readAt === null)?.message.id).toBe(second.body.message.id);
  });

  it('pushes new and read notifications to every socket of the mentioned user', async () => {
    const { owner, member, workspace, generalId } = await workspaceWithMember();
    const tab = await TestSocket.connect(node, member.agent);
    const otherTab = await TestSocket.connect(node, member.agent);
    const author = await TestSocket.connect(node, owner.agent);

    await say(owner.agent, generalId, `ping ${mentionToken(member.user.id)}`);
    const { notification } = await tab.next('notification.created');
    expect(notification).toMatchObject({ workspaceId: workspace.id, actor: { id: owner.user.id } });
    await otherTab.next('notification.created');
    await author.expectNone('notification.created');

    await member.agent.post('/api/notifications/read').send({ workspaceId: workspace.id });
    expect((await otherTab.next('notification.read')).ids).toEqual([notification.id]);

    await Promise.all([tab.close(), otherTab.close(), author.close()]);
  });
});
