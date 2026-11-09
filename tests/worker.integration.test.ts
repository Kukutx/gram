import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomInt } from 'node:crypto';
import { Api } from 'grammy';
import { createPrisma, type Database } from '../src/db/client.ts';
import { parseConfig } from '../src/config/env.ts';
import { startWorker } from '../src/worker.ts';
import { createLogger } from '../src/observability/logger.ts';
import { touchUser, deleteMyData } from '../src/db/repository.ts';
import { operationsHealth } from '../src/observability/operations.ts';
import { fakeTelegram } from './telegram-fixture.ts';
import { createNotifications } from '../src/queue/notifications.ts';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const redisSuite = process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL ? it : it.skip;
const config = parseConfig({
  BOT_TOKEN: '123456789:AAAAAAAAAAAAAAA',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://unused/unused',
});
const id = randomInt(1_500_000_000, 1_900_000_000);
let db: Database;
const logger = createLogger({ LOG_LEVEL: 'fatal' });
async function eventually(check: () => Promise<boolean>, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('Condition did not become true');
}

suite('maintenance and dispatch lifecycle with PostgreSQL', () => {
  beforeAll(async () => {
    db = createPrisma(config);
    await db.$connect();
    await touchUser(db, { id, is_bot: false, first_name: 'Worker Test' });
  });
  afterAll(async () => {
    await deleteMyData(db, id);
    await db.$disconnect();
  });
  const createFeedback = async (createdAt = new Date()) =>
    db.feedback.create({
      data: {
        userId: (await db.telegramUser.findUniqueOrThrow({ where: { telegramId: BigInt(id) } })).id,
        sourceUpdateId: randomInt(600_000_000, 1_000_000_000),
        text: 'Synthetic worker test',
        createdAt,
      },
    });
  it('runs retention without Redis or administrator and stops promptly', async () => {
    const old = await createFeedback(new Date(Date.now() - 3 * 86_400_000));
    const runtimeDb = createPrisma(config);
    const runtime = await startWorker({ ...config, FEEDBACK_RETENTION_DAYS: 1 }, runtimeDb, logger);
    try {
      await eventually(async () => (await db.feedback.count({ where: { id: old.id } })) === 0);
    } finally {
      await runtime.stop();
    }
  });
  it('does not let unavailable Redis suppress maintenance or bounded shutdown', async () => {
    const old = await createFeedback(new Date(Date.now() - 3 * 86_400_000));
    await createFeedback();
    const runtime = await startWorker(
      {
        ...config,
        FEEDBACK_RETENTION_DAYS: 1,
        ADMIN_TELEGRAM_ID: String(id),
        REDIS_URL: 'redis://127.0.0.1:59998',
      },
      createPrisma(config),
      logger,
    );
    try {
      await eventually(async () => (await db.feedback.count({ where: { id: old.id } })) === 0);
    } finally {
      const before = Date.now();
      await runtime.stop();
      expect(Date.now() - before).toBeLessThan(8_000);
    }
  });
  it('fails a disconnected Redis publication promptly rather than blocking the webhook', async () => {
    const producer = createNotifications(
      { ...config, ADMIN_TELEGRAM_ID: String(id), REDIS_URL: 'redis://127.0.0.1:59998' },
      logger,
    )!;
    const before = Date.now();
    try {
      await expect(producer.enqueueFeedback('synthetic')).rejects.toThrow();
    } finally {
      await producer.close().catch(() => {});
    }
    expect(Date.now() - before).toBeLessThan(4_000);
  });
  it('does not accept an earlier release heartbeat as proof of a new release', async () => {
    const health = await operationsHealth(db, { ...config, RELEASE_ID: `unstarted-${id}` });
    expect(health.workerFresh).toBe(false);
    expect(health.healthy).toBe(false);
  });
  it('dispatches from PostgreSQL alone and exposes a healthy heartbeat', async () => {
    const row = await createFeedback();
    const api = new Api(config.BOT_TOKEN);
    let sends = 0;
    api.config.use(
      fakeTelegram(() => {
        sends++;
        return {
          ok: true,
          result: { message_id: 1, date: 0, chat: { id, type: 'private' }, text: 'ok' },
        };
      }),
    );
    const runtime = await startWorker(
      { ...config, ADMIN_TELEGRAM_ID: String(id) },
      createPrisma(config),
      logger,
      api,
    );
    try {
      await eventually(
        async () =>
          (await db.feedback.findUniqueOrThrow({ where: { id: row.id } })).deliveryStatus === 'sent',
      );
      expect(sends).toBeGreaterThanOrEqual(1);
      expect(
        (await operationsHealth(db, { ...config, ADMIN_TELEGRAM_ID: String(id) })).dispatchFresh,
      ).toBe(true);
    } finally {
      await runtime.stop();
    }
  });
  redisSuite('recovers missing Redis jobs and delivers through BullMQ', async () => {
    const row = await createFeedback();
    const api = new Api(config.BOT_TOKEN);
    api.config.use(
      fakeTelegram(() => ({
        ok: true,
        result: { message_id: 1, date: 0, chat: { id, type: 'private' }, text: 'ok' },
      })),
    );
    const runtime = await startWorker(
      { ...config, ADMIN_TELEGRAM_ID: String(id), REDIS_URL: process.env.TEST_REDIS_URL },
      createPrisma(config),
      logger,
      api,
    );
    try {
      await eventually(
        async () =>
          (await db.feedback.findUniqueOrThrow({ where: { id: row.id } })).deliveryStatus === 'sent',
        18_000,
      );
    } finally {
      await runtime.stop();
    }
  });
});
