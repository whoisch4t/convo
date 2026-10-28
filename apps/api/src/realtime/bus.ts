import type { Redis } from 'ioredis';
import type { ServerEvent } from '@convo/shared';
import { logger } from '../lib/logger';

export type BusListener = (topic: string, event: ServerEvent) => void;

/**
 * Pub/sub between API instances. Every event goes through the bus, even when the publisher
 * and all subscribers are on the same instance, so one instance or ten behave the same.
 *
 * Each instance subscribes only to topics that one of its own sockets cares about.
 */
export interface Bus {
  publish(topic: string, event: ServerEvent): Promise<void>;
  subscribe(topic: string): Promise<void>;
  unsubscribe(topic: string): Promise<void>;
  /** Receives events for every topic this instance subscribed to. */
  setListener(listener: BusListener): void;
  close(): Promise<void>;
}

/** Instances that can reach each other. Tests create one per "cluster" to run several gateways in one process. */
export class MemoryNetwork {
  readonly nodes = new Set<MemoryBus>();
}

const defaultNetwork = new MemoryNetwork();

export class MemoryBus implements Bus {
  private topics = new Set<string>();
  private listener: BusListener | null = null;

  constructor(private network: MemoryNetwork = defaultNetwork) {
    network.nodes.add(this);
  }

  async publish(topic: string, event: ServerEvent) {
    // Serialise like Redis would, so Dates become strings in both modes.
    const payload = JSON.stringify(event);
    queueMicrotask(() => {
      for (const node of this.network.nodes) {
        if (node.topics.has(topic)) node.listener?.(topic, JSON.parse(payload) as ServerEvent);
      }
    });
  }

  async subscribe(topic: string) {
    this.topics.add(topic);
  }

  async unsubscribe(topic: string) {
    this.topics.delete(topic);
  }

  setListener(listener: BusListener) {
    this.listener = listener;
  }

  async close() {
    this.topics.clear();
    this.network.nodes.delete(this);
  }
}

/** Redis pub/sub. A subscribed connection cannot run other commands, so it uses a second connection. */
export class RedisBus implements Bus {
  private sub: Redis;
  private listener: BusListener | null = null;

  constructor(
    private pub: Redis,
    private prefix = 'convo:',
  ) {
    this.sub = pub.duplicate();
    this.sub.on('error', (err) => logger.error({ err }, 'Redis subscriber error'));
    this.sub.on('message', (channel: string, raw: string) => {
      if (!channel.startsWith(this.prefix)) return;
      try {
        this.listener?.(channel.slice(this.prefix.length), JSON.parse(raw) as ServerEvent);
      } catch (err) {
        logger.warn({ err, channel }, 'Dropped malformed bus message');
      }
    });
  }

  async publish(topic: string, event: ServerEvent) {
    await this.pub.publish(this.prefix + topic, JSON.stringify(event));
  }

  async subscribe(topic: string) {
    await this.sub.subscribe(this.prefix + topic);
  }

  async unsubscribe(topic: string) {
    await this.sub.unsubscribe(this.prefix + topic);
  }

  setListener(listener: BusListener) {
    this.listener = listener;
  }

  async close() {
    await this.sub.quit();
  }
}
