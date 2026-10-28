import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import type { ServerEvent } from '@convo/shared';
import { RedisBus } from '../src/realtime/bus';
import { RedisPresence } from '../src/realtime/presence';

// Runs only when a Redis server is available (CI sets TEST_REDIS_URL).
const url = process.env.TEST_REDIS_URL;

describe.skipIf(!url)('Redis backend', () => {
  const redis = url ? new Redis(url) : null;
  const prefix = `convo-test-${Date.now()}:`;

  afterAll(async () => {
    await redis?.quit();
  });

  it('delivers events between two bus instances only for subscribed topics', async () => {
    const a = new RedisBus(redis!.duplicate(), prefix);
    const b = new RedisBus(redis!.duplicate(), prefix);
    const received: [string, ServerEvent][] = [];
    b.setListener((topic, event) => received.push([topic, event]));
    await b.subscribe('ch:1');

    await a.publish('ch:1', { type: 'pong' });
    await a.publish('ch:2', { type: 'pong' });
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toEqual([['ch:1', { type: 'pong' }]]);

    await b.unsubscribe('ch:1');
    await a.publish('ch:1', { type: 'pong' });
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toHaveLength(1);
    await Promise.all([a.close(), b.close()]);
  });

  it('tracks presence per connection', async () => {
    const presence = new RedisPresence(redis!, `${prefix}presence:`);
    expect(await presence.add('u1', 'c1')).toBe(true);
    expect(await presence.add('u1', 'c2')).toBe(false);
    expect([...(await presence.online(['u1', 'u2']))]).toEqual(['u1']);
    expect(await presence.remove('u1', 'c1')).toBe(false);
    expect(await presence.remove('u1', 'c2')).toBe(true);
    expect((await presence.online(['u1'])).size).toBe(0);
  });
});
