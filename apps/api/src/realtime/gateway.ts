import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { clientEventSchema, TYPING_THROTTLE_MS, type ClientEvent, type ServerEvent } from '@convo/shared';
import { env } from '../env';
import { HttpError } from '../lib/errors';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { verifyWsTicket } from '../lib/tokens';
import { requireChannelAccess, requireWorkspaceMember } from '../modules/access';
import { createMessage, markRead } from '../modules/messages.service';
import type { Bus } from './bus';
import type { PresenceStore } from './presence';
import { topics } from './index';

interface Connection {
  id: string;
  user: { id: string; name: string };
  socket: WebSocket;
  alive: boolean;
  topics: Set<string>;
  workspaces: Set<string>;
  /** Joined channels of subscribed workspaces: channelId -> workspaceId. */
  channels: Map<string, string>;
  /** A channel being viewed without being a member (public channels). */
  focus: string | null;
  lastTyping: Map<string, number>;
  rate: { windowStart: number; count: number };
  /** Frames are handled one at a time, in order. */
  queue: Promise<void>;
}

export interface GatewayOptions {
  bus: Bus;
  presence: PresenceStore;
  path?: string;
  heartbeatMs?: number;
}

const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 100;
const RATE_DISCONNECT = 200;

function reject(socket: Duplex, status: number, text: string) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * Accepts WebSocket connections and routes events between sockets and the bus.
 *
 * Sockets join topics (workspace, channel, user). This instance subscribes to a topic on the
 * bus while at least one local socket needs it, and forwards every bus event to those sockets.
 */
export class Gateway {
  private wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  private connections = new Set<Connection>();
  private topicMembers = new Map<string, Set<Connection>>();
  private heartbeat: NodeJS.Timeout;
  private path: string;

  constructor(private opts: GatewayOptions) {
    this.path = opts.path ?? '/ws';
    opts.bus.setListener((topic, event) => this.deliver(topic, event));
    this.heartbeat = setInterval(() => void this.tick(), opts.heartbeatMs ?? 30_000);
    this.heartbeat.unref();
  }

  attach(server: Server) {
    server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
  }

  get connectionCount() {
    return this.connections.size;
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== this.path) return reject(socket, 404, 'Not Found');
    // Browsers always send Origin. Refusing others stops a different site from opening sockets.
    const origin = req.headers.origin;
    if (origin && origin !== env.WEB_ORIGIN) return reject(socket, 403, 'Forbidden');
    void verifyWsTicket(url.searchParams.get('ticket') ?? '').then((userId) => {
      if (!userId) return reject(socket, 401, 'Unauthorized');
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, userId));
    });
  }

  private onConnection(socket: WebSocket, userId: string) {
    const conn: Connection = {
      id: randomUUID(),
      user: { id: userId, name: '' },
      socket,
      alive: true,
      topics: new Set(),
      workspaces: new Set(),
      channels: new Map(),
      focus: null,
      lastTyping: new Map(),
      rate: { windowStart: Date.now(), count: 0 },
      queue: Promise.resolve(),
    };
    this.connections.add(conn);

    // Listeners go on right away; frames wait in the queue until setup is done.
    conn.queue = this.setup(conn).catch((err) => {
      logger.error({ err }, 'WebSocket setup failed');
      socket.close(1011, 'Setup failed');
    });
    socket.on('message', (data) => {
      conn.queue = conn.queue.then(() => this.onFrame(conn, data));
    });
    socket.on('pong', () => {
      conn.alive = true;
    });
    socket.on('close', () => void this.onClose(conn));
    socket.on('error', (err) => logger.warn({ err }, 'WebSocket error'));
  }

  private async setup(conn: Connection) {
    const user = await prisma.user.findUnique({ where: { id: conn.user.id }, select: { id: true, name: true } });
    if (!user) {
      conn.socket.close(4401, 'Unknown user');
      return;
    }
    conn.user = user;
    await this.join(conn, topics.user(user.id));
    if (await this.opts.presence.add(user.id, conn.id)) await this.announcePresence(user.id, 'online');
    this.send(conn, { type: 'hello', userId: user.id, connectionId: conn.id });
  }

  private async onClose(conn: Connection) {
    this.connections.delete(conn);
    for (const topic of [...conn.topics]) await this.leave(conn, topic);
    try {
      if (await this.opts.presence.remove(conn.user.id, conn.id)) await this.announcePresence(conn.user.id, 'offline');
    } catch (err) {
      logger.warn({ err }, 'Presence update failed');
    }
  }

  private async announcePresence(userId: string, status: 'online' | 'offline') {
    const memberships = await prisma.workspaceMember.findMany({ where: { userId }, select: { workspaceId: true } });
    await Promise.all(
      memberships.map(({ workspaceId }) =>
        this.opts.bus.publish(topics.workspace(workspaceId), { type: 'presence', workspaceId, userId, status }),
      ),
    );
  }

  // ---------- Incoming frames ----------

  private async onFrame(conn: Connection, data: RawData) {
    if (conn.socket.readyState !== WebSocket.OPEN) return;

    const now = Date.now();
    if (now - conn.rate.windowStart > RATE_WINDOW_MS) conn.rate = { windowStart: now, count: 0 };
    conn.rate.count += 1;
    if (conn.rate.count > RATE_DISCONNECT) return conn.socket.close(1008, 'Rate limit exceeded');
    if (conn.rate.count > RATE_MAX) {
      return this.send(conn, { type: 'error', code: 'RATE_LIMITED', message: 'Slow down' });
    }

    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      return this.send(conn, { type: 'error', code: 'BAD_REQUEST', message: 'Frames must be JSON' });
    }
    const parsed = clientEventSchema.safeParse(raw);
    if (!parsed.success) {
      // Echo the clientId so a rejected message (e.g. too long) can be marked as failed.
      const clientId = (raw as { clientId?: unknown } | null)?.clientId;
      return this.send(conn, {
        type: 'error',
        code: 'BAD_REQUEST',
        message: parsed.error.issues[0]?.message ?? 'Invalid event',
        ...(typeof clientId === 'string' ? { clientId } : {}),
      });
    }
    const event: ClientEvent = parsed.data;

    try {
      await this.handle(conn, event);
    } catch (err) {
      const clientId = event.type === 'message.send' ? event.clientId : undefined;
      if (err instanceof HttpError) {
        this.send(conn, { type: 'error', code: err.code, message: err.message, clientId });
      } else {
        logger.error({ err, event: event.type }, 'WebSocket handler failed');
        this.send(conn, { type: 'error', code: 'INTERNAL', message: 'Something went wrong', clientId });
      }
    }
  }

  private async handle(conn: Connection, event: ClientEvent) {
    switch (event.type) {
      case 'ping':
        return this.send(conn, { type: 'pong' });

      case 'workspace.subscribe': {
        const { workspaceId } = event;
        await requireWorkspaceMember(conn.user.id, workspaceId);
        conn.workspaces.add(workspaceId);
        await this.join(conn, topics.workspace(workspaceId));
        const joined = await prisma.channelMember.findMany({
          where: { userId: conn.user.id, channel: { workspaceId } },
          select: { channelId: true },
        });
        for (const { channelId } of joined) {
          conn.channels.set(channelId, workspaceId);
          await this.join(conn, topics.channel(channelId));
        }
        const members = await prisma.workspaceMember.findMany({ where: { workspaceId }, select: { userId: true } });
        const online = await this.opts.presence.online(members.map((m) => m.userId));
        return this.send(conn, { type: 'presence.snapshot', workspaceId, online: [...online] });
      }

      case 'channel.focus': {
        const previous = conn.focus;
        conn.focus = null;
        if (previous && !conn.channels.has(previous)) await this.leave(conn, topics.channel(previous));
        if (event.channelId) {
          await requireChannelAccess(conn.user.id, event.channelId);
          conn.focus = event.channelId;
          await this.join(conn, topics.channel(event.channelId));
        }
        return;
      }

      case 'message.send': {
        const message = await createMessage(conn.user.id, event.channelId, event.content);
        return this.send(conn, { type: 'message.ack', clientId: event.clientId, message });
      }

      case 'typing': {
        if (!conn.channels.has(event.channelId)) return;
        const now = Date.now();
        // A little slack so a client throttling at exactly TYPING_THROTTLE_MS is not dropped.
        if (now - (conn.lastTyping.get(event.channelId) ?? 0) < TYPING_THROTTLE_MS - 250) return;
        conn.lastTyping.set(event.channelId, now);
        return this.opts.bus.publish(topics.channel(event.channelId), {
          type: 'typing',
          channelId: event.channelId,
          user: conn.user,
        });
      }

      case 'read':
        await markRead(conn.user.id, event.channelId, event.messageId);
        return;
    }
  }

  // ---------- Outgoing events ----------

  private deliver(topic: string, event: ServerEvent) {
    const members = this.topicMembers.get(topic);
    if (!members) return;
    for (const conn of [...members]) {
      this.applySubscriptionChanges(conn, event);
      this.send(conn, event);
    }
  }

  /** Some events change what a socket should listen to (access granted or revoked, channel deleted…). */
  private applySubscriptionChanges(conn: Connection, event: ServerEvent) {
    const dropChannel = (channelId: string) => {
      conn.channels.delete(channelId);
      if (conn.focus === channelId) conn.focus = null;
      void this.leave(conn, topics.channel(channelId));
    };

    switch (event.type) {
      case 'channel.access':
        if (event.granted && conn.workspaces.has(event.workspaceId)) {
          conn.channels.set(event.channelId, event.workspaceId);
          void this.join(conn, topics.channel(event.channelId));
        } else if (!event.granted && conn.channels.has(event.channelId)) {
          dropChannel(event.channelId);
        }
        break;
      case 'channel.deleted':
        dropChannel(event.channelId);
        break;
      case 'workspace.member.left':
        if (event.userId === conn.user.id && conn.workspaces.has(event.workspaceId)) {
          conn.workspaces.delete(event.workspaceId);
          void this.leave(conn, topics.workspace(event.workspaceId));
          for (const [channelId, workspaceId] of conn.channels) {
            if (workspaceId === event.workspaceId) dropChannel(channelId);
          }
        }
        break;
    }
  }

  private send(conn: Connection, event: ServerEvent) {
    if (conn.socket.readyState === WebSocket.OPEN) conn.socket.send(JSON.stringify(event));
  }

  // ---------- Topic bookkeeping ----------

  private async join(conn: Connection, topic: string) {
    if (conn.topics.has(topic)) return;
    conn.topics.add(topic);
    let members = this.topicMembers.get(topic);
    if (!members) {
      members = new Set();
      this.topicMembers.set(topic, members);
      members.add(conn);
      await this.opts.bus.subscribe(topic);
      return;
    }
    members.add(conn);
  }

  private async leave(conn: Connection, topic: string) {
    if (!conn.topics.delete(topic)) return;
    const members = this.topicMembers.get(topic);
    if (!members) return;
    members.delete(conn);
    if (members.size === 0) {
      this.topicMembers.delete(topic);
      await this.opts.bus.unsubscribe(topic).catch((err) => logger.warn({ err, topic }, 'Unsubscribe failed'));
    }
  }

  // ---------- Heartbeat ----------

  /** Drops sockets that did not answer the last ping, and keeps presence entries alive. */
  private async tick() {
    for (const conn of this.connections) {
      if (!conn.alive) {
        conn.socket.terminate();
        continue;
      }
      conn.alive = false;
      conn.socket.ping();
    }
    await this.opts.presence
      .refresh([...this.connections].map((c) => ({ userId: c.user.id, connectionId: c.id })))
      .catch((err) => logger.warn({ err }, 'Presence refresh failed'));
  }

  async close() {
    clearInterval(this.heartbeat);
    for (const conn of this.connections) conn.socket.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
