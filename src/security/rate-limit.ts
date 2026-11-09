import { Redis } from 'ioredis';
import type { AppConfig } from '../config/env.ts';
import type { Logger } from '../observability/logger.ts';

import { InMemoryRateLimiter, REDIS_RATE_LIMIT_SCRIPT, WINDOW_MS } from './rate-limit-domain.ts';
export { isPrivacyCommand, isPrivacyCallback } from './rate-limit-domain.ts';

export interface RateLimiter {
  allow(userId: number): Promise<boolean>;
  forget(userId: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * Redis outage must never turn a fully functional PostgreSQL-backed Bot into
 * a 5xx-loop. Fall back to bounded per-instance throttling and log infrequently.
 */
export function createRateLimiter(config: AppConfig, logger: Logger): RateLimiter {
  const local = new InMemoryRateLimiter(config.RATE_LIMIT_PER_MINUTE);
  if (config.RATE_LIMIT_PER_MINUTE === 0) {
    return { allow: async () => true, forget: async () => {}, close: async () => {} };
  }
  if (!config.REDIS_URL) {
    logger.warn('Redis not configured: throttling is per-instance, not distributed');
    return {
      allow: async (id) => local.allow(id),
      forget: async (id) => {
        local.forget(id);
      },
      close: async () => {},
    };
  }

  const redis = new Redis(config.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 1_500,
    commandTimeout: 1_500,
    enableOfflineQueue: false,
  });
  let lastWarning = 0;
  let redisUnavailableUntil = 0;
  redis.on('error', () => {
    // Avoid duplicating every connection error into logs. The allow path will
    // emit a sanitized, rate-limited diagnostic with no URL or credentials.
  });
  return {
    async allow(userId: number): Promise<boolean> {
      const localAllowed = local.allow(userId);
      if (Date.now() < redisUnavailableUntil) return localAllowed;
      const bucket = Math.floor(Date.now() / WINDOW_MS);
      try {
        const count = await redis.eval(
          REDIS_RATE_LIMIT_SCRIPT,
          1,
          `grammy:rate:v1:${bucket}:${userId}`,
          WINDOW_MS * 2,
        );
        return Number(count) <= config.RATE_LIMIT_PER_MINUTE;
      } catch {
        redisUnavailableUntil = Date.now() + 30_000; // Avoid repeated per-update connect latency.
        if (Date.now() - lastWarning >= WINDOW_MS) {
          lastWarning = Date.now();
          logger.warn('Distributed rate limiting unavailable; falling back to in-process limit');
        }
        return localAllowed;
      }
    },
    async forget(userId: number): Promise<void> {
      local.forget(userId);
      const bucket = Math.floor(Date.now() / WINDOW_MS);
      try {
        await redis.del(`grammy:rate:v1:${bucket}:${userId}`, `grammy:rate:v1:${bucket - 1}:${userId}`);
      } catch {
        // Redis availability must not roll back or replay a completed data deletion.
        logger.warn('Redis unavailable while clearing a short-lived rate limit key');
      }
    },
    async close(): Promise<void> {
      redis.disconnect();
    },
  };
}
