import 'dotenv/config';
import * as Sentry from '@sentry/node';
import { parseConfig } from './config/env.ts';
import { createPrisma } from './db/client.ts';
import { createBot } from './bot/create-bot.ts';
import { createLogger } from './observability/logger.ts';
import { createServer } from './server.ts';
import { createRateLimiter } from './security/rate-limit.ts';
import { initMonitoring, reportError } from './observability/errors.ts';
import { scheduleTask, withDeadline } from './runtime/tasks.ts';
import { adminRecipients } from './bot/recipients.ts';
import { createAlerter, telegramSender } from './observability/alerts.ts';
import { operationsHealth } from './observability/operations.ts';

async function main(): Promise<void> {
  const config = parseConfig();
  const logger = createLogger(config);
  initMonitoring(config);

  // Register handlers before opening connections. Each resource is assigned as
  // soon as it is constructed so a mid-startup exception releases everything.
  let db: ReturnType<typeof createPrisma> | undefined;
  let rateLimiter: ReturnType<typeof createRateLimiter> | undefined;
  let bot: ReturnType<typeof createBot> | undefined;
  let app: ReturnType<typeof createServer> | undefined;
  let watchdog: ReturnType<typeof scheduleTask> | undefined;
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
    watchdog?.stop();
    if (bot?.isRunning()) await safeClose('bot', async () => bot!.stop());
    if (app) await safeClose('http', () => app!.close());
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
    rateLimiter = createRateLimiter(config, logger);
    bot = createBot({ config, db, logger, rateLimiter });
    // Health/metrics are served in both modes so any orchestrator can probe the process.
    app = createServer({ config, db, bot, logger });
    watchdog = watchWorker(config, db, bot, logger);

    if (config.BOT_MODE === 'webhook') {
      // Invalid Bot Token / unavailable Telegram API must fail before accepting webhooks.
      await bot.init();
      if (closing) return;
      // Registering the public Webhook is an independent operator action.
      await app.listen({ port: config.PORT, host: '0.0.0.0' });
      logger.info({ port: config.PORT, webhookPath: config.WEBHOOK_PATH }, 'Webhook server ready');
    } else {
      await app.listen({ port: config.PORT, host: '0.0.0.0' });
      // Polling is mutually exclusive with registered Telegram webhooks.
      await bot.api.deleteWebhook({ drop_pending_updates: false });
      if (closing) return;
      logger.info({ port: config.PORT }, 'Bot starting in long-polling mode');
      await bot.start({ onStart: (info) => logger.info({ username: info.username }, 'Bot started') });
    }
  } catch (error) {
    await shutdown('startup-failure');
    throw error;
  }
}

/**
 * The worker sends every message, so when it stops nothing reaches anyone, including its own
 * alerts. The bot process watches the worker's heartbeat and tells the admins directly.
 */
function watchWorker(
  config: ReturnType<typeof parseConfig>,
  db: ReturnType<typeof createPrisma>,
  bot: ReturnType<typeof createBot>,
  logger: ReturnType<typeof createLogger>,
) {
  const startedAt = Date.now();
  const alerter = createAlerter({
    send: telegramSender(bot.api),
    chats: adminRecipients(config).map((r) => Number(r.chatId)),
    language: config.DEFAULT_LANGUAGE,
    onError: (error) => logger.warn({ err: error }, 'Could not send a health alert'),
  });
  const task = scheduleTask(
    async () => {
      // The worker may start a little later than the bot.
      if (Date.now() - startedAt < 180_000) return;
      const health = await operationsHealth(db, config);
      await alerter.update(health.workerFresh ? [] : [{ kind: 'worker' }]);
    },
    60_000,
    (error) => logger.warn({ err: error }, 'Worker watchdog check failed'),
  );
  return task;
}

main().catch((error: unknown) => {
  // Avoid logging entire environment objects, URL values or Bot Token contents.
  createLogger({ LOG_LEVEL: 'error' }).error({ err: error }, 'Fatal startup error');
  reportError(error);
  process.exitCode = 1;
});
