import 'dotenv/config';
import * as Sentry from '@sentry/node';
import { parseConfig } from './config/env.ts';
import { createPrisma } from './db/client.ts';
import { createBot } from './bot/create-bot.ts';
import { createNotifications } from './queue/notifications.ts';
import { createLogger } from './observability/logger.ts';
import { createServer } from './server.ts';
import { createRateLimiter } from './security/rate-limit.ts';
import { initMonitoring, reportError } from './observability/errors.ts';
import { withDeadline } from './runtime/tasks.ts';

async function main(): Promise<void> {
  const config = parseConfig();
  const logger = createLogger(config);
  initMonitoring(config);

  // Register handlers before opening connections. Each resource is assigned as
  // soon as it is constructed so a mid-startup exception releases everything.
  let db: ReturnType<typeof createPrisma> | undefined;
  let notifications: ReturnType<typeof createNotifications> = undefined;
  let rateLimiter: ReturnType<typeof createRateLimiter> | undefined;
  let bot: ReturnType<typeof createBot> | undefined;
  let app: ReturnType<typeof createServer> | undefined;
  let closing = false;

  async function shutdown(signal: string): Promise<void> {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'Graceful shutdown started');
    const deadline = setTimeout(() => process.exit(1), 9_000);
    deadline.unref();
    let failed = false;
    async function safeClose(label: string, close: () => Promise<unknown>): Promise<void> {
      try {
        await withDeadline(close(), 2_000);
      } catch (error) {
        failed = true;
        logger.error({ err: error, component: label }, 'Shutdown operation failed');
      }
    }
    if (bot?.isRunning()) await safeClose('bot', async () => bot!.stop());
    if (app) await safeClose('http', () => app!.close());
    if (notifications) await safeClose('notifications', () => notifications!.close());
    if (rateLimiter) await safeClose('ratelimiter', () => rateLimiter!.close());
    if (db) await safeClose('postgres', () => db!.$disconnect());
    await safeClose('sentry', () => Sentry.flush(2_000));
    if (failed) process.exitCode = 1;
    else clearTimeout(deadline);
  }

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  try {
    db = createPrisma(config);
    await db.$connect();
    if (closing) {
      await db.$disconnect();
      return;
    }
    notifications = createNotifications(config, logger);
    rateLimiter = createRateLimiter(config, logger);
    bot = createBot({ config, db, logger, rateLimiter, ...(notifications ? { notifications } : {}) });
    app = config.BOT_MODE === 'webhook' ? createServer({ config, db, bot, logger }) : undefined;

    if (app) {
      // Invalid Bot Token / unavailable Telegram API must fail before accepting webhooks.
      await bot.init();
      if (closing) return;
      // Registering the public Webhook is an independent operator action.
      await app.listen({ port: config.PORT, host: '0.0.0.0' });
      logger.info({ port: config.PORT, webhookPath: config.WEBHOOK_PATH }, 'Webhook server ready');
    } else {
      // Polling is mutually exclusive with registered Telegram webhooks.
      await bot.api.deleteWebhook({ drop_pending_updates: false });
      if (closing) return;
      logger.info('Bot starting in long-polling mode');
      await bot.start({ onStart: (info) => logger.info({ username: info.username }, 'Bot started') });
    }
  } catch (error) {
    await shutdown('startup-failure');
    throw error;
  }
}

main().catch((error: unknown) => {
  // Avoid logging entire environment objects, URL values or Bot Token contents.
  createLogger({ LOG_LEVEL: 'error' }).error({ err: error }, 'Fatal startup error');
  reportError(error);
  process.exitCode = 1;
});
