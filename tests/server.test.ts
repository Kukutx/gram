import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bot } from 'grammy';
import { parseConfig } from '../src/config/env.ts';
import type { Database } from '../src/db/client.ts';
import type { BotContext } from '../src/bot/create-bot.ts';
import { createLogger } from '../src/observability/logger.ts';
import { createServer, verifyWebhookSecret } from '../src/server.ts';

const config = parseConfig({
  BOT_TOKEN: '123456789:AAAAAAAAAAAAAAA',
  BOT_MODE: 'webhook',
  WEBHOOK_SECRET: 'A'.repeat(48),
  METRICS_TOKEN: 'B'.repeat(48),
  DATABASE_URL: 'postgresql://example:example@localhost:5432/test',
});

function makeApp(dbOk = true) {
  const db = {
    $queryRaw: vi.fn(
      dbOk
        ? async () => [1]
        : async () => {
            throw new Error('unavailable');
          },
    ),
  } as unknown as Database;
  const bot = new Bot<BotContext>(config.BOT_TOKEN);
  return createServer({ config, db, bot, logger: createLogger(config) });
}

const opened: ReturnType<typeof makeApp>[] = [];
function openApp(dbOk = true) {
  const app = makeApp(dbOk);
  opened.push(app);
  return app;
}
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()));
});

describe('Webhook security and operational HTTP endpoints', () => {
  it('rejects missing or altered tokens with an independent constant-time check', () => {
    expect(verifyWebhookSecret(undefined, config.WEBHOOK_SECRET!)).toBe(false);
    expect(verifyWebhookSecret('B'.repeat(48), config.WEBHOOK_SECRET!)).toBe(false);
    expect(verifyWebhookSecret('A'.repeat(47), config.WEBHOOK_SECRET!)).toBe(false);
    expect(verifyWebhookSecret('A'.repeat(48), config.WEBHOOK_SECRET!)).toBe(true);
  });

  it('rejects requests before grammY can initialize or contact Telegram', async () => {
    const app = openApp();
    const response = await app.inject({
      method: 'POST',
      url: config.WEBHOOK_PATH,
      headers: { 'x-telegram-bot-api-secret-token': 'wrong' },
      payload: { update_id: 1 },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
  });

  it('provides liveness but refuses readiness when the database is down', async () => {
    const app = openApp(false);
    expect((await app.inject('/live')).statusCode).toBe(200);
    expect((await app.inject('/ready')).statusCode).toBe(503);
  });

  it('protects Prometheus metrics behind a bearer token', async () => {
    const app = openApp();
    expect((await app.inject('/metrics')).statusCode).toBe(401);
    const success = await app.inject({
      url: '/metrics',
      headers: { authorization: `Bearer ${config.METRICS_TOKEN}` },
    });
    expect(success.statusCode).toBe(200);
    expect(success.body).toContain('grammy_bot_updates_total');
  });
});
