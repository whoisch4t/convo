import type { Redis } from 'ioredis';

/** A connection counts as online until this long after its last heartbeat. */
export const PRESENCE_TTL_MS = 90_000;

/**
 * Tracks which users have at least one open socket, across all API instances.
 * Each connection is an entry with an expiry, refreshed by the heartbeat. If an instance
 * crashes, its entries simply expire instead of leaving users "online" forever.
 */
export interface PresenceStore {
  /** Returns true when this is the user's first live connection (they just came online). */
  add(userId: string, connectionId: string): Promise<boolean>;
  /** Returns true when the user has no live connections left (they just went offline). */
  remove(userId: string, connectionId: string): Promise<boolean>;
  refresh(entries: { userId: string; connectionId: string }[]): Promise<void>;
  /** The subset of `userIds` that are online. */
  online(userIds: string[]): Promise<Set<string>>;
  close(): Promise<void>;
}

export class MemoryPresence implements PresenceStore {
  private users = new Map<string, Map<string, number>>();

  private live(userId: string) {
    const conns = this.users.get(userId);
    if (!conns) return 0;
    const now = Date.now();
    for (const [id, expiresAt] of conns) if (expiresAt <= now) conns.delete(id);
    if (conns.size === 0) this.users.delete(userId);
    return conns.size;
  }

  async add(userId: string, connectionId: string) {
    const before = this.live(userId);
    const conns = this.users.get(userId) ?? new Map<string, number>();
    conns.set(connectionId, Date.now() + PRESENCE_TTL_MS);
    this.users.set(userId, conns);
    return before === 0;
  }

  async remove(userId: string, connectionId: string) {
    this.users.get(userId)?.delete(connectionId);
    return this.live(userId) === 0;
  }

  async refresh(entries: { userId: string; connectionId: string }[]) {
    for (const { userId, connectionId } of entries) {
      this.users.get(userId)?.set(connectionId, Date.now() + PRESENCE_TTL_MS);
    }
  }

  async online(userIds: string[]) {
    return new Set(userIds.filter((id) => this.live(id) > 0));
  }

  async close() {
    this.users.clear();
  }
}

/** One sorted set per user: members are connection ids, scores are expiry timestamps. */
export class RedisPresence implements PresenceStore {
  constructor(
    private redis: Redis,
    private prefix = 'convo:presence:',
  ) {}

  private key(userId: string) {
    return this.prefix + userId;
  }

  async add(userId: string, connectionId: string) {
    const now = Date.now();
    const key = this.key(userId);
    const result = await this.redis
      .multi()
      .zremrangebyscore(key, '-inf', now)
      .zadd(key, now + PRESENCE_TTL_MS, connectionId)
      .zcard(key)
      .pexpire(key, PRESENCE_TTL_MS)
      .exec();
    return Number(result?.[2]?.[1] ?? 0) === 1;
  }

  async remove(userId: string, connectionId: string) {
    const key = this.key(userId);
    const result = await this.redis
      .multi()
      .zrem(key, connectionId)
      .zremrangebyscore(key, '-inf', Date.now())
      .zcard(key)
      .exec();
    return Number(result?.[2]?.[1] ?? 0) === 0;
  }

  async refresh(entries: { userId: string; connectionId: string }[]) {
    if (entries.length === 0) return;
    const expiresAt = Date.now() + PRESENCE_TTL_MS;
    const pipeline = this.redis.pipeline();
    for (const { userId, connectionId } of entries) {
      pipeline.zadd(this.key(userId), 'XX', expiresAt, connectionId).pexpire(this.key(userId), PRESENCE_TTL_MS);
    }
    await pipeline.exec();
  }

  async online(userIds: string[]) {
    if (userIds.length === 0) return new Set<string>();
    const now = Date.now();
    const pipeline = this.redis.pipeline();
    for (const id of userIds) pipeline.zcount(this.key(id), `(${now}`, '+inf');
    const results = (await pipeline.exec()) ?? [];
    return new Set(userIds.filter((_, i) => Number(results[i]?.[1] ?? 0) > 0));
  }

  async close() {}
}
