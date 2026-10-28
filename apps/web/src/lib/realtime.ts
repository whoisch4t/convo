import type { ClientEventInput, ServerEvent } from '@convo/shared';
import { api } from './api';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'offline';
type Listener = (event: ServerEvent) => void;

const PING_EVERY_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 15_000;

function wsUrl() {
  if (process.env.NEXT_PUBLIC_WS_URL) return process.env.NEXT_PUBLIC_WS_URL;
  const { protocol, host } = window.location;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/ws`;
}

/**
 * One WebSocket per tab, reconnecting with exponential backoff and jitter.
 *
 * It remembers the workspace and focused channel and re-sends them after every reconnect,
 * then emits `reconnected` so the UI can refetch anything missed while offline.
 */
export class RealtimeClient {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<(status: ConnectionStatus) => void>();
  private reconnectListeners = new Set<() => void>();
  private attempt = 0;
  private timers: { reconnect?: number; ping?: number; pong?: number } = {};
  private workspaceId: string | null = null;
  private focusChannelId: string | null = null;
  private stopped = false;
  /** Bumped on every connect/stop, so a slow ticket request from an old attempt is ignored. */
  private generation = 0;
  private everConnected = false;
  status: ConnectionStatus = 'connecting';

  start() {
    this.stopped = false;
    void this.connect();
    window.addEventListener('online', this.onOnline);
  }

  stop() {
    this.stopped = true;
    this.generation += 1;
    window.removeEventListener('online', this.onOnline);
    this.clearTimers();
    this.socket?.close(1000, 'Client closed');
    this.socket = null;
  }

  private onOnline = () => {
    // The browser regained network: retry now instead of waiting for the backoff.
    if (this.status !== 'open') {
      window.clearTimeout(this.timers.reconnect);
      void this.connect();
    }
  };

  private setStatus(status: ConnectionStatus) {
    this.status = status;
    for (const l of this.statusListeners) l(status);
  }

  private clearTimers() {
    window.clearTimeout(this.timers.reconnect);
    window.clearInterval(this.timers.ping);
    window.clearTimeout(this.timers.pong);
  }

  private async connect() {
    if (this.stopped) return;
    const generation = ++this.generation;
    this.setStatus(this.everConnected ? 'reconnecting' : 'connecting');
    let ticket: string;
    try {
      ({ ticket } = await api<{ ticket: string }>('/realtime/ticket', { method: 'POST' }));
    } catch {
      if (generation === this.generation) this.scheduleReconnect();
      return;
    }
    if (this.stopped || generation !== this.generation) return;

    const socket = new WebSocket(`${wsUrl()}?ticket=${encodeURIComponent(ticket)}`);
    this.socket = socket;

    socket.onmessage = (msg) => {
      if (this.socket !== socket) return;
      let event: ServerEvent;
      try {
        event = JSON.parse(msg.data as string) as ServerEvent;
      } catch {
        return;
      }
      if (event.type === 'pong') {
        window.clearTimeout(this.timers.pong);
        return;
      }
      if (event.type === 'hello') return this.onHello();
      for (const l of this.listeners) l(event);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearTimers();
      this.scheduleReconnect();
    };
  }

  private onHello() {
    const wasReconnect = this.everConnected;
    this.everConnected = true;
    this.attempt = 0;
    this.setStatus('open');
    if (this.workspaceId) this.send({ type: 'workspace.subscribe', workspaceId: this.workspaceId });
    if (this.focusChannelId) this.send({ type: 'channel.focus', channelId: this.focusChannelId });
    if (wasReconnect) for (const l of this.reconnectListeners) l();

    // Application-level ping: browsers cannot see protocol pings, and a half-open TCP
    // connection would otherwise look "open" forever.
    this.timers.ping = window.setInterval(() => {
      this.send({ type: 'ping' });
      window.clearTimeout(this.timers.pong);
      this.timers.pong = window.setTimeout(() => this.socket?.close(4000, 'Ping timeout'), PONG_TIMEOUT_MS);
    }, PING_EVERY_MS);
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    this.setStatus(navigator.onLine ? 'reconnecting' : 'offline');
    // Full jitter keeps many clients from reconnecting at the same moment after a server restart.
    const ceiling = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempt);
    this.attempt += 1;
    this.timers.reconnect = window.setTimeout(() => void this.connect(), Math.random() * ceiling + 250);
  }

  /** Returns false when the socket is not open; callers decide whether to retry. */
  send(event: ClientEventInput) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(event));
    return true;
  }

  subscribeWorkspace(workspaceId: string) {
    this.workspaceId = workspaceId;
    this.send({ type: 'workspace.subscribe', workspaceId });
  }

  focusChannel(channelId: string | null) {
    if (this.focusChannelId === channelId) return;
    this.focusChannelId = channelId;
    this.send({ type: 'channel.focus', channelId });
  }

  on(listener: Listener) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  onStatus(listener: (status: ConnectionStatus) => void) {
    this.statusListeners.add(listener);
    return () => void this.statusListeners.delete(listener);
  }

  onReconnect(listener: () => void) {
    this.reconnectListeners.add(listener);
    return () => void this.reconnectListeners.delete(listener);
  }
}
