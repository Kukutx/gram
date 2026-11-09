import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomInt } from 'node:crypto';
import { GrammyError } from 'grammy';
import { createPrisma, type Database } from '../src/db/client.ts';
import { parseConfig } from '../src/config/env.ts';
import {
  beginFeedback,
  cancelFeedback,
  consumeFeedback,
  touchUser,
  deleteMyData,
} from '../src/db/repository.ts';
import {
  issueDeleteConfirmation,
  cancelDeleteConfirmation,
  consumeDeleteConfirmation,
  confirmationNonce,
} from '../src/privacy/delete-confirm.ts';
import { createBot } from '../src/bot/create-bot.ts';
import { createLogger } from '../src/observability/logger.ts';
import { changeTicket, queueReply, controlDelivery, myTickets } from '../src/db/tickets.ts';
import { deliverNotification } from '../src/queue/delivery.ts';
import { claimFeedbackDelivery } from '../src/db/notification-lease.ts';
import {
  getPersonalDataExportPage,
  getPersonalReplyExportPage,
  decodeExportCursor,
} from '../src/privacy/export.ts';
import { Api } from 'grammy';
import { fakeTelegram } from './telegram-fixture.ts';
import { createServer } from '../src/server.ts';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const config = parseConfig({
  BOT_TOKEN: '123456789:AAAAAAAAAAAAAAA',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://unused/unused',
});
const user = randomInt(1_000_000_000, 1_500_000_000);
const admin = user + 1;
const other = user + 2;
const base = randomInt(300_000_000, 600_000_000);
let seq = base;
const next = () => ++seq;
let db: Database;
const logger = createLogger({ LOG_LEVEL: 'fatal' });

suite('real PostgreSQL workflows and bot handlers', () => {
  beforeAll(async () => {
    db = createPrisma(config);
    await db.$connect();
    for (const id of [user, admin, other])
      await touchUser(db, { id, is_bot: false, first_name: 'Synthetic Test' });
  });
  afterAll(async () => {
    for (const id of [user, admin, other]) await deleteMyData(db, id);
    await db.commandReceipt.deleteMany({ where: { updateId: { gt: base, lte: seq } } });
    await db.$disconnect();
  });
  const feedback = async () => {
    await beginFeedback(db, user, next());
    return (await consumeFeedback(db, user, next(), 'Synthetic feedback'))!;
  };

  it('does not reactivate canceled state on duplicate or stale commands', async () => {
    const start = next();
    await beginFeedback(db, user, start);
    await cancelFeedback(db, user, next());
    await beginFeedback(db, user, start);
    await beginFeedback(db, user, start - 1);
    expect(
      (await db.telegramUser.findUniqueOrThrow({ where: { telegramId: BigInt(user) } }))
        .awaitingFeedback,
    ).toBe(false);
  });
  it('serializes concurrent duplicate submissions and competing leases', async () => {
    await beginFeedback(db, user, next());
    const update = next();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => consumeFeedback(db, user, update, 'Concurrent feedback')),
    );
    expect(new Set(results.map((item) => item?.id)).size).toBe(1);
    expect(results[0]).not.toBeNull();
    const claims = await Promise.all(
      ['a', 'b', 'c'].map((token) => claimFeedbackDelivery(db, results[0]!.id, token)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
  it('supports assign, durable replies, resolve, close and reopen with audit records', async () => {
    const ticket = await feedback();
    expect(await changeTicket(db, admin, next(), ticket.id, 'assign')).toBe('saved');
    const update = next();
    const reply = await queueReply(db, admin, update, ticket.id, 'Synthetic answer');
    expect(await queueReply(db, admin, update, ticket.id, 'Synthetic answer')).toBe(reply);
    const api = new Api(config.BOT_TOKEN);
    let sends = 0;
    api.config.use(
      fakeTelegram(() => {
        sends++;
        return {
          ok: true,
          result: { message_id: 1, date: 0, chat: { id: user, type: 'private' }, text: 'ok' },
        };
      }),
    );
    await Promise.all([
      deliverNotification(db, api, admin, { replyId: reply }, logger),
      deliverNotification(db, api, admin, { replyId: reply }, logger),
    ]);
    expect(sends).toBe(1);
    expect((await db.feedbackReply.findUniqueOrThrow({ where: { id: reply } })).deliveryStatus).toBe(
      'sent',
    );
    await changeTicket(db, admin, next(), ticket.id, 'resolved');
    await changeTicket(db, admin, next(), ticket.id, 'closed');
    expect(await queueReply(db, admin, next(), ticket.id, 'later')).toBe('closed');
    await changeTicket(db, admin, next(), ticket.id, 'open');
    expect((await myTickets(db, user)).find((row) => row.id === ticket.id)?.status).toBe('open');
    expect(await db.feedbackEvent.count({ where: { feedbackId: ticket.id } })).toBeGreaterThanOrEqual(5);
  });
  it('parks permanent send errors and lets an operator retry or dismiss them', async () => {
    const ticket = await feedback();
    const api = new Api(config.BOT_TOKEN);
    api.config.use(async () => {
      throw new GrammyError(
        'Synthetic',
        { ok: false, error_code: 403, description: 'Forbidden' },
        'sendMessage',
        { text: 'PRIVATE' },
      );
    });
    await deliverNotification(db, api, admin, { feedbackId: ticket.id }, logger);
    expect((await db.feedback.findUniqueOrThrow({ where: { id: ticket.id } })).deliveryStatus).toBe(
      'blocked',
    );
    await controlDelivery(db, admin, next(), ticket.id, 'retry');
    expect((await db.feedback.findUniqueOrThrow({ where: { id: ticket.id } })).deliveryStatus).toBe(
      'pending',
    );
    await controlDelivery(db, admin, next(), ticket.id, 'dismiss');
    expect(await claimFeedbackDelivery(db, ticket.id, 'disabled')).toBe(false);
  });
  it('deletes despite failed callback acknowledgement and rejects replay after account recreation', async () => {
    const confirmation = await issueDeleteConfirmation(db, user, next(), config.BOT_TOKEN);
    const bot = createBot({ config, db, logger });
    bot.botInfo = {
      id: 123456789,
      is_bot: true,
      first_name: 'Audit',
      username: 'audit_bot',
    } as typeof bot.botInfo;
    bot.api.config.use(
      fakeTelegram((method) =>
        method === 'answerCallbackQuery'
          ? { ok: false, error_code: 400, description: 'query too old' }
          : { ok: true, result: true },
      ),
    );
    const callback = {
      update_id: next(),
      callback_query: {
        id: 'old-query',
        from: { id: user, is_bot: false as const, first_name: 'Test' },
        chat_instance: 'test',
        data: confirmation,
        message: {
          message_id: 1,
          date: 0,
          chat: { id: user, type: 'private' as const, first_name: 'Test' },
        },
      },
    };
    await bot.handleUpdate(callback);
    expect(await db.telegramUser.count({ where: { telegramId: BigInt(user) } })).toBe(0);
    await touchUser(db, { id: user, is_bot: false, first_name: 'Recreated' });
    const newFeedback = await feedback();
    await bot.handleUpdate(callback);
    expect(await db.feedback.findUnique({ where: { id: newFeedback.id } })).not.toBeNull();
  });
  it('revokes a canceled nonce and refuses wrong-user confirmation', async () => {
    const confirmation = await issueDeleteConfirmation(db, user, next(), config.BOT_TOKEN);
    expect(await consumeDeleteConfirmation(db, other, confirmation, config.BOT_TOKEN)).toBe(false);
    await cancelDeleteConfirmation(db, user, confirmationNonce(confirmation));
    expect(await consumeDeleteConfirmation(db, user, confirmation, config.BOT_TOKEN)).toBe(false);
  });
  it('replays an authenticated webhook after reply failure without undoing a later cancel', async () => {
    const webhookConfig = { ...config, BOT_MODE: 'webhook' as const, WEBHOOK_SECRET: 'A'.repeat(48) };
    const bot = createBot({ config: webhookConfig, db, logger });
    bot.botInfo = {
      id: 123456789,
      is_bot: true,
      first_name: 'Audit',
      username: 'audit_bot',
    } as typeof bot.botInfo;
    let fail = true;
    bot.api.config.use(
      fakeTelegram(() =>
        fail
          ? { ok: false, error_code: 403, description: 'Synthetic reply failure' }
          : { ok: true, result: true },
      ),
    );
    const app = createServer({ config: webhookConfig, db, bot, logger });
    const updateId = next();
    const payload = {
      update_id: updateId,
      message: {
        message_id: updateId,
        date: 0,
        chat: { id: user, type: 'private', first_name: 'Test' },
        from: { id: user, first_name: 'Test', is_bot: false },
        text: '/feedback',
        entities: [{ type: 'bot_command', offset: 0, length: 9 }],
      },
    };
    const request = {
      method: 'POST' as const,
      url: webhookConfig.WEBHOOK_PATH,
      headers: { 'x-telegram-bot-api-secret-token': webhookConfig.WEBHOOK_SECRET },
      payload,
    };
    try {
      expect((await app.inject(request)).statusCode).toBe(500);
      await cancelFeedback(db, user, next());
      fail = false;
      expect((await app.inject(request)).statusCode).toBe(200);
      expect(
        (await db.telegramUser.findUniqueOrThrow({ where: { telegramId: BigInt(user) } }))
          .awaitingFeedback,
      ).toBe(false);
    } finally {
      await app.close();
    }
  });
  it('refuses non-admin reply commands without creating reply or audit records', async () => {
    const ticket = await feedback();
    const bot = createBot({ config: { ...config, ADMIN_TELEGRAM_ID: String(admin) }, db, logger });
    bot.botInfo = {
      id: 123456789,
      is_bot: true,
      first_name: 'Audit',
      username: 'audit_bot',
    } as typeof bot.botInfo;
    bot.api.config.use(fakeTelegram(() => ({ ok: true, result: true })));
    const text = `/reply ${ticket.id} unauthorized`;
    await bot.handleUpdate({
      update_id: next(),
      message: {
        message_id: 1,
        date: 1,
        chat: { id: other, type: 'private', first_name: 'Test' },
        from: { id: other, first_name: 'Test', is_bot: false },
        text,
        entities: [{ type: 'bot_command', offset: 0, length: 6 }],
      },
    });
    expect(await db.feedbackReply.count({ where: { feedbackId: ticket.id } })).toBe(0);
    expect(await db.feedbackEvent.count({ where: { feedbackId: ticket.id } })).toBe(0);
  });
  it('persists temporary failure cooldown and supports an explicit recovery retry', async () => {
    const ticket = await feedback();
    const api = new Api(config.BOT_TOKEN);
    api.config.use(
      fakeTelegram(() => ({ ok: false, error_code: 500, description: 'Synthetic temporary failure' })),
    );
    await expect(
      deliverNotification(db, api, admin, { feedbackId: ticket.id }, logger),
    ).rejects.toThrow();
    const row = await db.feedback.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(row.deliveryStatus).toBe('pending');
    expect(row.lastDeliveryErrorCode).toBe(500);
    expect(await claimFeedbackDelivery(db, ticket.id, 'during-cooldown')).toBe(false);
    expect(await controlDelivery(db, admin, next(), ticket.id, 'retry')).toBe('saved');
    expect(await claimFeedbackDelivery(db, ticket.id, 'after-explicit-retry')).toBe(true);
  });
  it('paginates real data without exporting another user and cascades replies on erasure', async () => {
    const owner = await db.telegramUser.findUniqueOrThrow({ where: { telegramId: BigInt(user) } });
    const stranger = await db.telegramUser.findUniqueOrThrow({ where: { telegramId: BigInt(other) } });
    await db.feedback.createMany({
      data: Array.from({ length: 55 }, () => ({
        userId: owner.id,
        sourceUpdateId: next(),
        text: 'OWN',
      })),
    });
    await db.feedback.create({
      data: { userId: stranger.id, sourceUpdateId: next(), text: 'DO_NOT_EXPORT' },
    });
    const page = (await getPersonalDataExportPage(db, user))!;
    expect(page.count).toBe(50);
    expect(page.nextCursor).not.toBeNull();
    const second = (await getPersonalDataExportPage(db, user, decodeExportCursor(page.nextCursor!)))!;
    expect(second.fileContents.toString()).not.toContain('DO_NOT_EXPORT');
    const ticket = await feedback();
    await queueReply(db, admin, next(), ticket.id, 'OWN_REPLY');
    const replies = await getPersonalReplyExportPage(db, user);
    expect(replies.fileContents.toString()).toContain('OWN_REPLY');
    const confirmation = await issueDeleteConfirmation(db, user, next(), config.BOT_TOKEN);
    expect(await consumeDeleteConfirmation(db, user, confirmation, config.BOT_TOKEN)).toBe(true);
    expect(await db.feedbackReply.count({ where: { feedbackId: ticket.id } })).toBe(0);
    expect(await db.feedbackEvent.count({ where: { feedbackId: ticket.id } })).toBe(0);
    await touchUser(db, { id: user, is_bot: false, first_name: 'Test' });
  });
});
