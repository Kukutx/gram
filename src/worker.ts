import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Api } from 'grammy';
import { AbortController } from 'abort-controller';
import { autoRetry } from '@grammyjs/auto-retry';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import * as Sentry from '@sentry/node';
import { parseConfig, adminId, type AppConfig } from './config/env.ts';
import { createPrisma, type Database } from './db/client.ts';
import { purgeExpiredFeedback, RETENTION_BATCH_SIZE } from './maintenance/retention.ts';
import { RECEIPT_RETENTION_MS } from './db/commands.ts';
import { createLogger, type Logger } from './observability/logger.ts';
import { initMonitoring, reportError } from './observability/errors.ts';
import { heartbeat, operationsHealth } from './observability/operations.ts';
import { FEEDBACK_QUEUE, type FeedbackJob } from './queue/notifications.ts';
import { deliverNotification } from './queue/delivery.ts';
import { decideRecoveryAction } from './queue/reconciliation.ts';
import { nextOutboxCursor, outboxWhere, type OutboxCursor } from './queue/outbox.ts';
import { scheduleTask, withDeadline } from './runtime/tasks.ts';

export async function startWorker(config: AppConfig, db: Database, logger: Logger, apiOverride?: Api) {
  const startedAt = Date.now();
  const instance = `${config.RELEASE_ID ?? 'local'}:${randomUUID()}`;
  const admin = adminId(config);
  const api = apiOverride ?? new Api(config.BOT_TOKEN, { timeoutSeconds: 8 });
  api.config.use(autoRetry({ maxRetryAttempts: 2, maxDelaySeconds: 5 }));
  let consumer: Redis | undefined;
  let producer: Redis | undefined;
  let queue: Queue<FeedbackJob> | undefined;
  let worker: Worker<FeedbackJob> | undefined;
  let closing = false;
  const abort = new AbortController();
  const tasks: ReturnType<typeof scheduleTask>[] = [];
  const failed = (error: unknown) => {
    logger.error({ err: error }, 'Worker task failed');
    reportError(error);
  };
  // Signals are registered before any I/O. The platform's termination budget is bounded.
  const stop = async () => {
    if (closing) return;
    closing = true;
    abort.abort();
    tasks.forEach((task) => task.stop());
    const forceExit = setTimeout(() => process.exit(1), 9_000);
    forceExit.unref();
    try {
      await withDeadline(Promise.all(tasks.map((task) => task.settled())), 1_500).catch(failed);
      await withDeadline(worker?.close() ?? Promise.resolve(), 1_500).catch(failed);
      await withDeadline(queue?.close() ?? Promise.resolve(), 1_000).catch(failed);
    } finally {
      consumer?.disconnect();
      producer?.disconnect();
      await withDeadline(worker?.disconnect() ?? Promise.resolve(), 1_000).catch(failed);
      await withDeadline(db.$disconnect(), 1_000).catch(failed);
      await Sentry.flush(1_000);
      clearTimeout(forceExit);
    }
  };
  const onSignal = () => {
    void stop().catch(failed);
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  const dispose = async () => {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    await stop();
  };
  try {
    await db.$connect();
    if (closing) return { stop: dispose };
    if (config.REDIS_URL && admin !== undefined) {
      consumer = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, connectTimeout: 1_500 });
      producer = new Redis(config.REDIS_URL, {
        maxRetriesPerRequest: 1,
        connectTimeout: 1_500,
        commandTimeout: 1_500,
        enableOfflineQueue: false,
      });
      consumer.on('error', () => {});
      producer.on('error', () => {});
      queue = new Queue<FeedbackJob>(FEEDBACK_QUEUE, {
        connection: producer,
        defaultJobOptions: {
          attempts: 6,
          backoff: { type: 'exponential', delay: 3_000 },
          removeOnComplete: { age: 7 * 86_400, count: 20_000 },
          removeOnFail: { age: 30 * 86_400, count: 20_000 },
        },
      });
      worker = new Worker<FeedbackJob>(
        FEEDBACK_QUEUE,
        (job) => deliverNotification(db, api, admin, job.data, logger, abort.signal),
        { connection: consumer, concurrency: 2 },
      );
      worker.on('error', failed);
      worker.on('failed', (_job, error) => failed(error));
      queue.on('error', failed);
    }
    let feedbackCursor: OutboxCursor | undefined;
    let replyCursor: OutboxCursor | undefined;
    tasks.push(
      scheduleTask(
        async () => {
          await heartbeat(db, 'worker:' + instance, 'worker');
        },
        15_000,
        failed,
      ),
    );
    tasks.push(
      scheduleTask(
        async () => {
          // Maintenance requires only PostgreSQL, independently of notifications.
          for (let batch = 0; batch < 10; batch++) {
            if (
              closing ||
              (await purgeExpiredFeedback(db, config.FEEDBACK_RETENTION_DAYS)) < RETENTION_BATCH_SIZE
            )
              break;
          }
          const old = new Date(Date.now() - RECEIPT_RETENTION_MS);
          const receipts = await db.commandReceipt.findMany({
            where: { createdAt: { lt: old } },
            take: 1_000,
            select: { updateId: true },
          });
          if (receipts.length)
            await db.commandReceipt.deleteMany({
              where: { updateId: { in: receipts.map((row) => row.updateId) } },
            });
          await db.runtimeHeartbeat.deleteMany({ where: { lastSeenAt: { lt: old } } });
          await heartbeat(db, 'retention:' + instance, 'retention');
        },
        30_000,
        failed,
      ),
    );
    if (admin !== undefined)
      tasks.push(
        scheduleTask(
          async () => {
            const [feedback, replies] = await Promise.all([
              db.feedback.findMany({
                where: outboxWhere(feedbackCursor),
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                take: 200,
                select: { id: true, createdAt: true },
              }),
              db.feedbackReply.findMany({
                where: outboxWhere(replyCursor),
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                take: 200,
                select: { id: true, createdAt: true },
              }),
            ]);
            let lastProgressHeartbeat = Date.now();
            try {
              for (const [kind, rows] of [
                ['feedback', feedback],
                ['reply', replies],
              ] as const) {
                for (const row of rows) {
                  if (closing) return;
                  if (Date.now() - lastProgressHeartbeat >= 30_000) {
                    await heartbeat(db, 'dispatch:' + instance, 'dispatch');
                    lastProgressHeartbeat = Date.now();
                  }
                  const jobId = kind + '_' + row.id;
                  const data = kind === 'feedback' ? { feedbackId: row.id } : { replyId: row.id };
                  if (queue) {
                    if (producer?.status !== 'ready') throw new Error('Queue unavailable');
                    await withDeadline(
                      (async () => {
                        const job = await queue!.getJob(jobId);
                        const action = decideRecoveryAction(
                          job ? await job.getState() : undefined,
                          job?.finishedOn,
                          job?.attemptsMade ?? 0,
                        );
                        if (action === 'enqueue') {
                          if (job) await job.remove();
                          await queue!.add('notify', data, { jobId });
                        } else if ((action === 'retry' || action === 'replace') && job) {
                          await job.retry(action === 'retry' ? 'failed' : 'completed', {
                            resetAttemptsMade: true,
                          });
                        }
                      })(),
                      2_000,
                    );
                  } else {
                    await deliverNotification(db, api, admin, data, logger, abort.signal).catch(failed);
                  }
                }
              }
              feedbackCursor = nextOutboxCursor(feedback);
              replyCursor = nextOutboxCursor(replies);
              await heartbeat(db, 'dispatch:' + instance, 'dispatch');
            } catch (error) {
              feedbackCursor = undefined;
              replyCursor = undefined;
              throw error;
            }
          },
          15_000,
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
    // Never await one task before registering the other schedules.
    tasks.forEach((task) => {
      void task.run();
    });
    logger.info(
      { notifications: admin !== undefined, redis: Boolean(queue) },
      'Worker and maintenance scheduler started',
    );
    return { stop: dispose };
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
