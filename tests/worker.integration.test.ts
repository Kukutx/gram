import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomInt } from 'node:crypto';
import { Api } from 'grammy';
import { createPrisma, type Database } from '../src/db/client.ts';
import { parseConfig, type AppConfig } from '../src/config/env.ts';
import { startWorker } from '../src/worker.ts';
import { createLogger } from '../src/observability/logger.ts';
import { deleteMyData, touchUser } from '../src/db/users.ts';
import { openTicket } from '../src/db/tickets.ts';
import { operationsHealth } from '../src/observability/operations.ts';
import { recordingTelegram } from './telegram-fixture.ts';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const id = randomInt(1_500_000_000, 1_900_000_000);
const adminChat = id + 1;
const config = parseConfig({
  BOT_TOKEN: '123456789:AAAAAAAAAAAAAAA',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://unused/unused',
  OUTBOX_POLL_MS: '60000', // only NOTIFY can make these tests pass quickly
});
const withAdmin: AppConfig = { ...config, ADMIN_IDS: [adminChat] };
let seq = randomInt(600_000_000, 900_000_000);
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

const open = async (text: string) => {
  const result = await openTicket(db, id, ++seq, { text, attachment: null }, [{ chatId: adminChat }], {
    requireAwaiting: false,
  });
  if (result.kind !== 'created') throw new Error('expected a ticket');
  return result;
};

suite('worker lifecycle with PostgreSQL', () => {
  beforeAll(async () => {
    db = createPrisma(config);
    await db.$connect();
    await touchUser(db, { id, is_bot: false, first_name: 'Worker Test' });
  });
  afterAll(async () => {
    await deleteMyData(db, id);
    await db.$disconnect();
  });

  it('runs retention without administrators and stops promptly', async () => {
    const old = await open('old');
    await db.ticket.update({
      where: { id: old.ticketId },
      data: { lastMessageAt: new Date(Date.now() - 3 * 86_400_000) },
    });
    const api = new Api(config.BOT_TOKEN);
    api.config.use(recordingTelegram().transformer);
    const runtime = await startWorker(
      { ...config, FEEDBACK_RETENTION_DAYS: 1 },
      createPrisma(config),
      logger,
      {
        api,
        listen: false,
      },
    );
    try {
      await eventually(async () => (await db.ticket.count({ where: { id: old.ticketId } })) === 0);
    } finally {
      const before = Date.now();
      await runtime.stop();
      expect(Date.now() - before).toBeLessThan(5_000);
    }
  });

  it('does not accept an earlier release heartbeat as proof of a new release', async () => {
    const health = await operationsHealth(db, { ...config, RELEASE_ID: `unstarted-${id}` });
    expect(health.workerFresh).toBe(false);
    expect(health.healthy).toBe(false);
  });

  it('wakes on NOTIFY, delivers in order per chat and records a dispatch heartbeat', async () => {
    const telegram = recordingTelegram();
    const api = new Api(config.BOT_TOKEN);
    api.config.use(telegram.transformer);
    const runtime = await startWorker(withAdmin, createPrisma(config), logger, { api });
    try {
      // Let the listener connect before inserting; with a 60s poll only NOTIFY delivers in time.
      await eventually(async () => (await operationsHealth(db, withAdmin)).dispatchFresh);
      const first = await open('first in order');
      const second = await open('second in order');
      await eventually(async () => {
        const sent = await db.delivery.count({
          where: { messageId: { in: [first.messageId, second.messageId] }, status: 'sent' },
        });
        return sent === 2;
      });
      const texts = telegram
        .of('sendMessage')
        .filter((c) => c.payload.chat_id === adminChat)
        .map((c) => String(c.payload.text));
      expect(texts.findIndex((t) => t.includes('first in order'))).toBeLessThan(
        texts.findIndex((t) => t.includes('second in order')),
      );
    } finally {
      await runtime.stop();
    }
  });

  it('retries temporary Telegram failures from the outbox without losing the message', async () => {
    let failures = 1;
    const telegram = recordingTelegram({
      // Only this test's message fails: rows other tests left behind are sent normally.
      fail: (call) =>
        call.method === 'sendMessage' &&
        String(call.payload.text).includes('flaky network') &&
        failures-- > 0
          ? { ok: false, error_code: 502, description: 'Bad Gateway' }
          : undefined,
    });
    const api = new Api(config.BOT_TOKEN);
    api.config.use(telegram.transformer);
    const ticket = await open('flaky network');
    const runtime = await startWorker(withAdmin, createPrisma(config), logger, { api, listen: false });
    try {
      await eventually(async () => {
        const row = await db.delivery.findFirstOrThrow({ where: { messageId: ticket.messageId } });
        return row.lastErrorCode === 502 && row.status === 'pending';
      });
      // Skip the backoff instead of waiting for it.
      await db.delivery.updateMany({
        where: { messageId: ticket.messageId },
        data: { leaseUntil: null },
      });
      runtime.dispatcher!.wake();
      await eventually(
        async () =>
          (await db.delivery.findFirstOrThrow({ where: { messageId: ticket.messageId } })).status ===
          'sent',
      );
    } finally {
      await runtime.stop();
    }
  });
});
