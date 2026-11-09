import 'dotenv/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { parseConfig } from '../src/config/env.ts';
import { createPrisma } from '../src/db/client.ts';
import { classifyOutboxHealth } from '../src/observability/outbox-health.ts';
import { FEEDBACK_QUEUE, type FeedbackJob } from '../src/queue/notifications.ts';
import { operationsHealth } from '../src/observability/operations.ts';

/** An operator diagnostic: outputs only aggregate counts, never feedback or secrets. */
async function main(): Promise<void> {
  const config = parseConfig();
  const db = createPrisma(config);
  const now = new Date();
  try {
    await db.$connect();
    const [pending, oldest, activeLeases] = await Promise.all([
      db.feedback.count({ where: { notifiedAt: null, deliveryStatus: 'pending' } }),
      db.feedback.findFirst({
        where: { notifiedAt: null, deliveryStatus: 'pending' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { createdAt: true },
      }),
      db.feedback.count({ where: { notifiedAt: null, deliveryLeaseUntil: { gt: now } } }),
    ]);
    const health = classifyOutboxHealth(pending, oldest?.createdAt ?? null, now);
    const notificationsEnabled = Boolean(config.ADMIN_TELEGRAM_ID);
    const operational = await operationsHealth(db, config);
    let queue: Record<string, unknown> = {
      configured: Boolean(config.REDIS_URL && notificationsEnabled),
      mode: config.REDIS_URL ? 'redis' : 'postgresql',
    };
    let queueReachable = true;
    if (config.REDIS_URL && config.ADMIN_TELEGRAM_ID) {
      const redis = new Redis(config.REDIS_URL, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 2_000,
        enableOfflineQueue: false,
        retryStrategy: () => null,
      });
      redis.on('error', () => {}); // Connectivity is represented in the aggregate status.
      try {
        await redis.connect();
        const bull = new Queue<FeedbackJob>(FEEDBACK_QUEUE, { connection: redis });
        try {
          const counts = await bull.getJobCounts(
            'waiting',
            'active',
            'delayed',
            'completed',
            'failed',
            'paused',
          );
          queue = { configured: true, reachable: true, counts };
        } finally {
          await bull.close();
        }
      } catch {
        queue = { configured: true, reachable: false };
        queueReachable = false;
      } finally {
        redis.disconnect();
      }
    }
    console.log(
      JSON.stringify(
        {
          asOf: now.toISOString(),
          outbox: { pending, activeLeases, ...health, notificationsEnabled },
          operational,
          queue,
        },
        null,
        2,
      ),
    );
    if (!queueReachable) process.exitCode = 3;
    else if (!operational.healthy) process.exitCode = 2;
  } finally {
    await db.$disconnect();
  }
}

main().catch(() => {
  // Avoid accidentally serializing sensitive connection strings.
  console.error('Outbox diagnostic failed; check database and Redis connectivity.');
  process.exitCode = 1;
});
