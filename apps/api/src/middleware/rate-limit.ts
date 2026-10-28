import type { NextFunction, Request, Response } from 'express';
import { store } from '../lib/cache';
import { tooManyRequests } from '../lib/errors';
import { logger } from '../lib/logger';

interface RateLimitOptions {
  /** Prefix that separates this limiter's counters from others. */
  name: string;
  windowMs: number;
  max: number;
  key?: (req: Request) => string;
}

/** Fixed-window rate limiter backed by the shared store (Redis or memory). */
export function rateLimit({ name, windowMs, max, key = (req) => req.ip ?? 'unknown' }: RateLimitOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { count, ttlMs } = await store.incr(`rl:${name}:${key(req)}`, windowMs);
      const retryAfter = Math.ceil(ttlMs / 1000);
      res.setHeader('RateLimit-Limit', max);
      res.setHeader('RateLimit-Remaining', Math.max(0, max - count));
      res.setHeader('RateLimit-Reset', retryAfter);
      if (count > max) {
        res.setHeader('Retry-After', retryAfter);
        return next(tooManyRequests(retryAfter));
      }
    } catch (err) {
      // If the store is down, let the request through instead of locking everyone out.
      logger.warn({ err }, 'Rate limiter store failed');
    }
    next();
  };
}
