import request from 'supertest';
import { createApp } from '../src/app';

export const app = createApp();

let counter = 0;

/** Registers a fresh user and returns a supertest agent that keeps its auth cookies. */
export async function signedInAgent(name = 'Test User') {
  counter += 1;
  const agent = request.agent(app);
  const email = `user${counter}-${Date.now()}@example.com`;
  const res = await agent.post('/api/auth/register').send({ name, email, password: 'password123' });
  if (res.status !== 201) throw new Error(`Register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, user: res.body.user as { id: string; email: string }, email, password: 'password123' };
}

/** Reads a cookie value from a Set-Cookie header list. */
export function cookieValue(setCookie: string[] | string | undefined, name: string) {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = list.find((c) => c.startsWith(`${name}=`));
  return match?.split(';')[0]?.slice(name.length + 1);
}

type Agent = Awaited<ReturnType<typeof signedInAgent>>['agent'];

/** Creates a workspace and returns it with its #general channel id and invite code. */
export async function createWorkspace(agent: Agent, name = 'Acme') {
  const res = await agent.post('/api/workspaces').send({ name });
  if (res.status !== 201) throw new Error(`Create workspace failed: ${res.status} ${JSON.stringify(res.body)}`);
  const workspace = res.body.workspace as { id: string; inviteCode: string };
  const channels = await agent.get(`/api/workspaces/${workspace.id}/channels`);
  const general = (channels.body.items as { id: string; name: string }[]).find((c) => c.name === 'general')!;
  return { workspace, generalId: general.id };
}

/** Owner with a workspace plus a second member who joined by invite code. */
export async function workspaceWithMember() {
  const owner = await signedInAgent('Owner');
  const member = await signedInAgent('Member');
  const { workspace, generalId } = await createWorkspace(owner.agent);
  const join = await member.agent.post('/api/workspaces/join').send({ inviteCode: workspace.inviteCode });
  if (join.status !== 201) throw new Error(`Join failed: ${join.status} ${JSON.stringify(join.body)}`);
  return { owner, member, workspace, generalId };
}
