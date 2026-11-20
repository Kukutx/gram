import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Api } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import * as Sentry from '@sentry/node';
import { parseConfig, type AppConfig } from './config/env.ts';
import { createPrisma, type Database } from './db/client.ts';
import { expandLegacyAdminDeliveries } from './db/outbox.ts';
import { adminRecipients } from './bot/recipients.ts';
import { createDispatcher, type Dispatcher } from './delivery/dispatcher.ts';
import {
  purgeExpiredTickets,
  purgeRuntimeMetadata,
  RETENTION_BATCH_SIZE,
} from './maintenance/retention.ts';
import { createLogger, type Logger } from './observability/logger.ts';
import { initMonitoring, reportError } from './observability/errors.ts';
import { heartbeat, operationsHealth } from './observability/operations.ts';
import { scheduleTask, withDeadline } from './runtime/tasks.ts';
import { createServer } from './server.ts';

export type WorkerOptions = {
  /** Test seam: a Telegram API with a fake transport. */
  api?: Api;
  /** Disable LISTEN/NOTIFY (tests, or poolers without session support). */
  listen?: boolean;
};

/**
 * The worker owns everything that must happen without a Telegram update:
 * sending the outbox, retention, receipt cleanup, heartbeats and health alerts.
 * Several workers may run at once; the outbox lease keeps sends exclusive.
 */
export async function startWorker(
  config: AppConfig,
  db: Database,
  logger: Logger,
  options: WorkerOptions = {},
) {
  const startedAt = Date.now();
  const instance = `${config.RELEASE_ID ?? 'local'}:${randomUUID()}`;
  const api = options.api ?? new Api(config.BOT_TOKEN, { timeoutSeconds: 15 });
  // Only flood-control waits are retried in place. Network and 5xx errors go back to the
  // outbox, whose durable backoff never pins a dispatcher slot (auto-retry would retry
  // network errors forever).
  api.config.use(
    autoRetry({
      maxRetryAttempts: 2,
      maxDelaySeconds: 10,
      rethrowHttpErrors: true,
      rethrowInternalServerErrors: true,
    }),
  );
  const tasks: ReturnType<typeof scheduleTask>[] = [];
  let dispatcher: Dispatcher | undefined;
  let probes: ReturnType<typeof createServer> | undefined;
  let closing = false;
  const failed = (error: unknown) => {
    logger.error({ err: error }, 'Worker task failed');
    reportError(error);
  };

  // Signals are registered before any I/O. The platform's termination budget is bounded.
  const stop = async () => {
    if (closing) return;
    closing = true;
    tasks.forEach((task) => task.stop());
    const forceExit = setTimeout(() => process.exit(1), 9_000);
    forceExit.unref();
    try {
      await withDeadline(probes?.close() ?? Promise.resolve(), 1_000).catch(failed);
      await withDeadline(dispatcher?.stop() ?? Promise.resolve(), 3_000).catch(failed);
      await withDeadline(Promise.all(tasks.map((task) => task.settled())), 1_500).catch(failed);
    } finally {
      await withDeadline(db.$disconnect(), 1_000).catch(failed);
      await Sentry.flush(1_000);
      clearTimeout(forceExit);
    }
  };
  const onSignal = () => void stop().catch(failed);
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  const dispose = async () => {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    await stop();
  };

  try {
    await db.$connect();
    if (closing) return { stop: dispose, dispatcher };
    const expanded = await expandLegacyAdminDeliveries(
      db,
      adminRecipients(config).map((r) => Number(r.chatId)),
    );
    if (expanded) logger.info({ expanded }, 'Expanded v1 admin notices to configured recipients');

    tasks.push(scheduleTask(() => heartbeat(db, `worker:${instance}`, 'worker'), 15_000, failed));
    tasks.push(
      scheduleTask(
        async () => {
          for (let batch = 0; batch < 10 && !closing; batch++)
            if ((await purgeExpiredTickets(db, config.FEEDBACK_RETENTION_DAYS)) < RETENTION_BATCH_SIZE)
              break;
          await purgeRuntimeMetadata(db);
          await heartbeat(db, `retention:${instance}`, 'retention');
        },
        30_000,
        failed,
      ),
    );
    let lastAlert = 0;
    tasks.push(
      scheduleTask(
        async () => {
          const health = await operationsHealth(db, config);
          if (
            !health.healthy &&
            Date.now() - startedAt >= 120_000 &&
            Date.now() - lastAlert > 60 * 60_000
          ) {
            lastAlert = Date.now();
            logger.error({ health }, 'Operational health requires attention');
            Sentry.captureMessage('Bot operational health requires attention', 'error');
          }
        },
        60_000,
        failed,
      ),
    );

    let lastDispatchBeat = 0;
    dispatcher = createDispatcher(
      { db, api, config, logger },
      {
        concurrency: config.DELIVERY_CONCURRENCY,
        pollMs: config.OUTBOX_POLL_MS,
        ...(options.listen === false || !config.OUTBOX_LISTEN ? {} : { listenUrl: config.DATABASE_URL }),
        onError: failed,
        onCycle: async () => {
          if (Date.now() - lastDispatchBeat < 15_000) return;
          lastDispatchBeat = Date.now();
          await heartbeat(db, `dispatch:${instance}`, 'dispatch');
        },
      },
    );

    if (config.WORKER_HEALTH_PORT > 0) {
      // Optional /live, /ready (and token-protected /ops/health, /metrics) for container probes.
      probes = createServer({ config, db, logger });
      await probes.listen({ port: config.WORKER_HEALTH_PORT, host: '0.0.0.0' });
    }
    // Never await one task before registering the other schedules.
    tasks.forEach((task) => void task.run());
    dispatcher.start();
    logger.info(
      { recipients: adminRecipients(config).length, concurrency: config.DELIVERY_CONCURRENCY },
      'Worker started',
    );
    return { stop: dispose, dispatcher };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function main() {
  const config = parseConfig();
  initMonitoring(config);
  await startWorker(config, createPrisma(config), createLogger(config));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    createLogger({ LOG_LEVEL: 'error' }).error({ err: error }, 'Fatal worker error');
    reportError(error);
    process.exitCode = 1;
  });
}
