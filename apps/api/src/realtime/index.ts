import { Redis } from 'ioredis';
import type { ServerEvent } from '@convo/shared';
import { env, isTest } from '../env';
import { logger } from '../lib/logger';
import { MemoryBus, RedisBus, type Bus } from './bus';
import { MemoryPresence, RedisPresence, type PresenceStore } from './presence';

/** Topic names. Sockets subscribe to topics; services publish events to them. */
export const topics = {
  /** Presence, public channel changes and membership changes of a workspace. */
  workspace: (workspaceId: string) => `ws:${workspaceId}`,
  /** Messages, typing and read receipts of one channel. */
  channel: (channelId: string) => `ch:${channelId}`,
  /** Events for one person, e.g. being added to a private channel. */
  user: (userId: string) => `user:${userId}`,
};

function createRealtimeBackend(): { bus: Bus; presence: PresenceStore; redis: Redis | null } {
  if (env.REDIS_URL && !isTest) {
    const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
    redis.on('error', (err) => logger.error({ err }, 'Redis error'));
    logger.info('Using Redis for realtime fan-out and presence');
    return { bus: new RedisBus(redis), presence: new RedisPresence(redis), redis };
  }
  return { bus: new MemoryBus(), presence: new MemoryPresence(), redis: null };
}

export const realtime = createRealtimeBackend();

/** Publishes an event to every socket subscribed to `topic`, on any instance. Never throws. */
export function publish(topic: string, event: ServerEvent) {
  realtime.bus.publish(topic, event).catch((err) => logger.error({ err, topic }, 'Publish failed'));
}
