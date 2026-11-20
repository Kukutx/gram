import { describe, expect, it, vi } from 'vitest';
import { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { createBot, type BotContext } from '../src/bot/create-bot.ts';
import { ADMIN_COMMANDS, helpText, USER_COMMANDS } from '../src/bot/commands.ts';
import { parseConfig } from '../src/config/env.ts';
import type { Database } from '../src/db/client.ts';
import { touchUser } from '../src/db/users.ts';
import { en } from '../src/domain/locales/en.ts';
import { zh } from '../src/domain/locales/zh.ts';
import { createLogger } from '../src/observability/logger.ts';
import { createServer } from '../src/server.ts';

const config = parseConfig({
  BOT_TOKEN: '123456789:AAAAAAAAAAAAAAA',
  DATABASE_URL: 'postgresql://example:example@localhost:5432/test',
});
const logger = createLogger({ LOG_LEVEL: 'fatal' });

describe('long polling resilience', () => {
  it('logs and skips a failed update instead of stopping the polling loop', async () => {
    const failing = async () => {
      throw new Error('transient database failure');
    };
    const db = {
      commandReceipt: { findUnique: failing },
      telegramUser: { findUnique: failing },
    } as unknown as Database;
    const bot = createBot({ config, db, logger });
    bot.botInfo = {
      id: 1,
      is_bot: true,
      first_name: 'Test',
      username: 'test_bot',
    } as typeof bot.botInfo;
    const update = {
      update_id: 7,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 5, type: 'private' as const, first_name: 'U' },
        from: { id: 5, is_bot: false as const, first_name: 'U' },
        text: 'hello',
      },
    };
    // grammY's polling loop calls this for each batch; a rejection would stop polling.
    const polling = bot as unknown as { handleUpdates(updates: Update[]): Promise<void> };
    await expect(polling.handleUpdates([update])).resolves.toBeUndefined();
  });
});

describe('per-update user loading', () => {
  const from = { id: 42, is_bot: false as const, first_name: 'Ann', username: 'ann' };
  const now = new Date('2026-11-20T00:00:00Z');
  const snapshot = (lastSeenAt: Date, username = 'ann') => ({
    id: 'u1',
    telegramId: 42n,
    username,
    firstName: 'Ann',
    language: 'en',
    awaitingFeedback: false,
    feedbackExpiresAt: null,
    bannedAt: null,
    lastSeenAt,
  });
  const fakeDb = (existing: ReturnType<typeof snapshot> | null) => {
    const upsert = vi.fn(async () => snapshot(now));
    const db = {
      telegramUser: { findUnique: vi.fn(async () => existing), upsert },
    } as unknown as Database;
    return { db, upsert };
  };

  it('skips the write for a recently seen, unchanged profile', async () => {
    const { db, upsert } = fakeDb(snapshot(new Date(now.getTime() - 60_000)));
    await touchUser(db, from, now);
    expect(upsert).not.toHaveBeenCalled();
  });
  it('refreshes lastSeenAt after the throttle window or on a profile change', async () => {
    const stale = fakeDb(snapshot(new Date(now.getTime() - 10 * 60_000)));
    await touchUser(stale.db, from, now);
    expect(stale.upsert).toHaveBeenCalledOnce();
    const renamed = fakeDb(snapshot(now, 'old_name'));
    await touchUser(renamed.db, from, now);
    expect(renamed.upsert).toHaveBeenCalledOnce();
    const created = fakeDb(null);
    await touchUser(created.db, from, now);
    expect(created.upsert).toHaveBeenCalledOnce();
  });
});

describe('localization completeness', () => {
  const placeholders = (text: string) => [...text.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]).sort();
  it('uses identical placeholders in every language', () => {
    for (const key of Object.keys(zh) as (keyof typeof zh)[])
      expect(placeholders(en[key]), key).toEqual(placeholders(zh[key]));
  });
  it('lists admin commands in /help only for admins', () => {
    expect(helpText('en', false)).not.toContain('/reply');
    expect(helpText('en', true)).toContain('/reply');
    for (const spec of [...USER_COMMANDS, ...ADMIN_COMMANDS])
      expect(spec.command).toMatch(/^[a-z0-9_]{1,32}$/);
  });
});

describe('HTTP probes in polling mode', () => {
  it('serves health endpoints without exposing a webhook route', async () => {
    const db = { $queryRaw: vi.fn(async () => [1]) } as unknown as Database;
    const app = createServer({ config, db, bot: new Bot<BotContext>(config.BOT_TOKEN), logger });
    try {
      expect((await app.inject('/live')).statusCode).toBe(200);
      expect((await app.inject('/ready')).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: config.WEBHOOK_PATH })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
