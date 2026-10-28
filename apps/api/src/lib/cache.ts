import { Redis } from 'ioredis';
import { env, isTest } from '../env';
import { logger } from './logger';

/**
 * Small key-value store used for rate limiting.
 * Uses Redis when REDIS_URL is set, otherwise an in-memory map (fine for one instance).
 */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Increments a counter and returns its new value and remaining TTL (ms). The TTL starts on first increment. */
  incr(key: string, ttlMs: number): Promise<{ count: number; ttlMs: number }>;
  close(): Promise<void>;
}

class MemoryStore implements KeyValueStore {
  private data = new Map<string, { value: string; expiresAt: number }>();

  private read(key: string) {
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.data.delete(key);
      return null;
    }
    return entry;
  }

  async get(key: string) {
    return this.read(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSeconds: number) {
    this.data.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async del(key: string) {
    this.data.delete(key);
  }

  async incr(key: string, ttlMs: number) {
    const entry = this.read(key);
    if (!entry) {
      this.data.set(key, { value: '1', expiresAt: Date.now() + ttlMs });
      return { count: 1, ttlMs };
    }
    entry.value = String(Number(entry.value) + 1);
    return { count: Number(entry.value), ttlMs: entry.expiresAt - Date.now() };
  }

  async close() {
    this.data.clear();
  }
}

class RedisStore implements KeyValueStore {
  constructor(private redis: Redis) {}

  async get(key: string) {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number) {
    await this.redis.set(key, value, 'EX', ttlSeconds);
  }

  async del(key: string) {
    await this.redis.del(key);
  }

  async incr(key: string, ttlMs: number) {
    // INCR and PEXPIRE NX in one round trip so the window starts on the first hit only.
    const result = await this.redis.multi().incr(key).pexpire(key, ttlMs, 'NX').pttl(key).exec();
    const count = Number(result?.[0]?.[1] ?? 1);
    const ttl = Number(result?.[2]?.[1] ?? ttlMs);
    return { count, ttlMs: ttl > 0 ? ttl : ttlMs };
  }

  async close() {
    await this.redis.quit();
  }
}

function createStore(): KeyValueStore {
  if (env.REDIS_URL && !isTest) {
    const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false });
    redis.on('error', (err) => logger.error({ err }, 'Redis error'));
    logger.info('Using Redis for cache and rate limits');
    return new RedisStore(redis);
  }
  return new MemoryStore();
}

export const store = createStore();
