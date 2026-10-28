import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { ClientEventInput, ServerEvent } from '@convo/shared';
import { createApp } from '../src/app';
import { realtime } from '../src/realtime';
import { MemoryBus, type Bus } from '../src/realtime/bus';
import { Gateway } from '../src/realtime/gateway';
import type { signedInAgent } from './helpers';

type Agent = Awaited<ReturnType<typeof signedInAgent>>['agent'];

export interface TestNode {
  server: Server;
  gateway: Gateway;
  wsUrl: string;
  close(): Promise<void>;
}

/**
 * Starts an API instance with its own gateway on a random port.
 * Every node shares the in-memory "network" and presence store, the way real instances share Redis.
 */
export async function startNode(bus: Bus = new MemoryBus()): Promise<TestNode> {
  const server = createServer(createApp());
  const gateway = new Gateway({ bus, presence: realtime.presence, heartbeatMs: 60_000 });
  gateway.attach(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    gateway,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    async close() {
      await gateway.close();
      await bus.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A WebSocket client that buffers events so tests can wait for the one they expect. */
export class TestSocket {
  private buffer: ServerEvent[] = [];
  private waiters: { match: (e: ServerEvent) => boolean; resolve: (e: ServerEvent) => void }[] = [];

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const event = JSON.parse(data.toString()) as ServerEvent;
      const waiter = this.waiters.find((w) => w.match(event));
      if (waiter) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(event);
      } else {
        this.buffer.push(event);
      }
    });
  }

  static async connect(node: TestNode, agent: Agent, headers: Record<string, string> = {}) {
    const { body } = await agent.post('/api/realtime/ticket');
    const ws = new WebSocket(`${node.wsUrl}?ticket=${encodeURIComponent(body.ticket)}`, { headers });
    const socket = new TestSocket(ws);
    await socket.next('hello');
    return socket;
  }

  send(event: ClientEventInput | Record<string, unknown>) {
    this.ws.send(JSON.stringify(event));
  }

  /** Resolves with the next event of `type` (optionally matching `where`), including ones already received. */
  next<T extends ServerEvent['type']>(
    type: T,
    where: (e: Extract<ServerEvent, { type: T }>) => boolean = () => true,
    timeoutMs = 3000,
  ): Promise<Extract<ServerEvent, { type: T }>> {
    const match = (e: ServerEvent) => e.type === type && where(e as Extract<ServerEvent, { type: T }>);
    const index = this.buffer.findIndex(match);
    if (index >= 0) return Promise.resolve(this.buffer.splice(index, 1)[0] as Extract<ServerEvent, { type: T }>);

    return new Promise((resolve, reject) => {
      const waiter = { match, resolve: resolve as (e: ServerEvent) => void };
      this.waiters.push(waiter);
      setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          reject(new Error(`Timed out waiting for "${type}". Buffered: ${this.buffer.map((e) => e.type).join(', ')}`));
        }
      }, timeoutMs);
    });
  }

  /** Asserts that no event of `type` arrives within `ms`. */
  async expectNone<T extends ServerEvent['type']>(
    type: T,
    where: (e: Extract<ServerEvent, { type: T }>) => boolean = () => true,
    ms = 300,
  ) {
    await new Promise((r) => setTimeout(r, ms));
    const found = this.buffer.find((e) => e.type === type && where(e as Extract<ServerEvent, { type: T }>));
    if (found) throw new Error(`Did not expect "${type}" but got ${JSON.stringify(found)}`);
  }

  /** Subscribes to a workspace and waits until the server confirmed it with a presence snapshot. */
  async subscribe(workspaceId: string) {
    this.send({ type: 'workspace.subscribe', workspaceId });
    return this.next('presence.snapshot', (e) => e.workspaceId === workspaceId);
  }

  close() {
    return new Promise<void>((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

/** Opens a socket with a raw URL and reports the HTTP status of a refused upgrade. */
export function upgradeStatus(url: string, headers: Record<string, string> = {}) {
  return new Promise<number>((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('open', () => {
      ws.close();
      resolve(101);
    });
    ws.on('error', () => {});
  });
}
