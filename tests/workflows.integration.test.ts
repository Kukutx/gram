import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomInt, randomUUID } from 'node:crypto';
import { Api, type Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { createPrisma, type Database } from '../src/db/client.ts';
import { parseConfig, type AppConfig } from '../src/config/env.ts';
import { cancelFeedback, deleteMyData, touchUser } from '../src/db/users.ts';
import {
  cancelDeleteConfirmation,
  confirmationNonce,
  consumeDeleteConfirmation,
  issueDeleteConfirmation,
} from '../src/privacy/delete-confirm.ts';
import { createBot, type BotContext } from '../src/bot/create-bot.ts';
import { createLogger } from '../src/observability/logger.ts';
import { addStaffMessage, openTicket } from '../src/db/tickets.ts';
import { decodeExportCursor, getPersonalDataExportPage } from '../src/privacy/export.ts';
import { claimDeliveries, releaseDelivery } from '../src/db/outbox.ts';
import { sendDelivery } from '../src/delivery/sender.ts';
import { createServer } from '../src/server.ts';
import { recordingTelegram } from './telegram-fixture.ts';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const BOT_ID = 123456789;
const user = randomInt(1_000_000_000, 1_500_000_000);
const admin = user + 1;
const other = user + 2;
const stranger = user + 3; // no ticket at first
const blockedUser = user + 4; // a chat of its own: older sends to `user` would go first
const group = -randomInt(1_000_000_000_000, 1_900_000_000_000);
let seq = randomInt(300_000_000, 600_000_000);
const next = () => ++seq;
const base = parseConfig({
  BOT_TOKEN: `${BOT_ID}:AAAAAAAAAAAAAAA`,
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://unused/unused',
  DEFAULT_LANGUAGE: 'en',
});
const groupConfig: AppConfig = {
  ...base,
  ADMIN_IDS: [admin],
  ADMIN_CHAT_ID: group,
  ADMIN_USE_TOPICS: true,
};
const logger = createLogger({ LOG_LEVEL: 'fatal' });
let db: Database;

const person = (id: number) => ({
  id,
  is_bot: false as const,
  first_name: `User ${id}`,
  language_code: 'en',
});
const privateChat = (id: number) => ({ id, type: 'private' as const, first_name: `User ${id}` });
const supergroup = { id: group, type: 'supergroup' as const, title: 'Support', is_forum: true as const };

function message(
  from: number,
  fields: Record<string, unknown>,
  chat: object = privateChat(from),
): Update {
  const text = typeof fields.text === 'string' ? fields.text : undefined;
  const command = text?.match(/^\/\w+/)?.[0];
  return {
    update_id: next(),
    message: {
      message_id: randomInt(1, 1_000_000),
      date: Math.floor(Date.now() / 1000),
      chat,
      from: person(from),
      ...(command ? { entities: [{ type: 'bot_command', offset: 0, length: command.length }] } : {}),
      ...fields,
    },
  } as Update;
}

function callback(from: number, data: string, chat: object = privateChat(from)): Update {
  return {
    update_id: next(),
    callback_query: {
      id: randomUUID(),
      from: person(from),
      chat_instance: 'test',
      data,
      message: { message_id: 1, date: 0, chat },
    },
  } as Update;
}

/** A tap on a button of the bot's prompt that quoted (replied to) `source`. */
function offerTap(from: number, data: string, source: Update): Update {
  const update = callback(from, data);
  const tapped = update.callback_query!.message as unknown as Record<string, unknown>;
  tapped.reply_to_message = source.message;
  return update;
}

function makeBot(config: AppConfig, telegram = recordingTelegram()) {
  const bot = createBot({ config, db, logger });
  bot.botInfo = {
    id: BOT_ID,
    is_bot: true,
    first_name: 'Test',
    username: 'test_bot',
  } as Bot<BotContext>['botInfo'];
  bot.api.config.use(telegram.transformer);
  return { bot, telegram };
}

/** Sends every due outbox row of these chats through the real sender; returns what it sent. */
async function flush(config: AppConfig, chats: number[]) {
  const telegram = recordingTelegram();
  const api = new Api(config.BOT_TOKEN);
  api.config.use(telegram.transformer);
  const token = randomUUID();
  const claimed = await claimDeliveries(db, token, 500);
  const rows = await db.delivery.findMany({
    where: { id: { in: claimed } },
    select: { id: true, chatId: true },
  });
  for (const row of rows) {
    if (chats.includes(Number(row.chatId)))
      await sendDelivery({ db, api, config, logger }, row.id, token);
    else await releaseDelivery(db, row.id, token);
  }
  return telegram;
}

const replies = (telegram: ReturnType<typeof recordingTelegram>) =>
  telegram.of('sendMessage').map((c) => String(c.payload.text));

suite('bot workflows on PostgreSQL with a recorded Telegram API', () => {
  beforeAll(async () => {
    db = createPrisma(base);
    await db.$connect();
  });
  afterAll(async () => {
    for (const id of [user, admin, other, stranger, blockedUser]) await deleteMyData(db, id);
    await db.delivery.deleteMany({ where: { chatId: BigInt(group) } });
    await db.$disconnect();
  });

  it('runs a full ticket through a forum-topic support group', async () => {
    const { bot, telegram } = makeBot(groupConfig);
    await bot.handleUpdate(message(user, { text: '/feedback' }));
    await bot.handleUpdate(
      message(user, {
        caption: 'Screen is blank',
        photo: [{ file_id: 'photo-file', file_unique_id: 'p', width: 9, height: 9 }],
      }),
    );
    const created = replies(telegram).at(-1)!;
    const number = Number(/#(\d+)/.exec(created)?.[1]);
    expect(number).toBeGreaterThan(0);
    const ticket = await db.ticket.findUniqueOrThrow({ where: { number } });
    const inbound = await db.ticketMessage.findFirstOrThrow({ where: { ticketId: ticket.id } });
    expect(inbound).toMatchObject({
      direction: 'inbound',
      attachmentType: 'photo',
      attachmentId: 'photo-file',
    });

    // The worker opens a topic for the ticket and posts the photo there with action buttons.
    let sent = await flush(groupConfig, [group]);
    expect(sent.of('createForumTopic')).toHaveLength(1);
    const photo = sent.last('sendPhoto')!;
    const threadId = Number(photo.payload.message_thread_id);
    expect(threadId).toBeGreaterThan(9000);
    expect(String(photo.payload.caption)).toContain(`#${number}`);
    expect(JSON.stringify(photo.payload.reply_markup)).toContain(`tk:${number}:resolved`);
    expect((await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).adminThreadId).toBe(
      threadId,
    );

    // Any group member typing in the topic answers the user.
    telegram.clear();
    await bot.handleUpdate(
      message(
        admin,
        { text: 'Try restarting', message_thread_id: threadId, is_topic_message: true },
        supergroup,
      ),
    );
    expect(telegram.of('setMessageReaction')).toHaveLength(1);
    expect((await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('in_progress');
    sent = await flush(groupConfig, [user]);
    const toUser = sent.last('sendMessage')!;
    expect(toUser.payload.chat_id).toBe(user);
    expect(String(toUser.payload.text)).toContain('Try restarting');
    expect(String(toUser.payload.text)).toContain(`#${number}`);

    // The user replies to that message: it is added to the same ticket and sent to the topic.
    const delivered = await db.delivery.findFirstOrThrow({
      where: { chatId: BigInt(user), status: 'sent' },
    });
    telegram.clear();
    await bot.handleUpdate(
      message(user, {
        text: 'Still blank',
        reply_to_message: {
          message_id: delivered.sentMessageId,
          date: 0,
          chat: privateChat(user),
          from: { id: BOT_ID, is_bot: true, first_name: 'Test' },
        },
      }),
    );
    expect(replies(telegram).at(-1)).toContain(`#${number}`);
    sent = await flush(groupConfig, [group]);
    expect(sent.of('createForumTopic')).toHaveLength(0); // reuses the topic
    expect(sent.last('sendMessage')?.payload.message_thread_id).toBe(threadId);

    // Buttons change status and notify the user; strangers cannot press them.
    telegram.clear();
    await bot.handleUpdate(callback(other, `tk:${number}:resolved`));
    expect((await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('in_progress');
    await bot.handleUpdate(callback(admin, `tk:${number}:resolved`, supergroup));
    expect((await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('resolved');
    expect(String(telegram.last('answerCallbackQuery')?.payload.text)).toContain(`#${number}`);
    sent = await flush(groupConfig, [user]);
    expect(String(sent.last('sendMessage')?.payload.text)).toContain('resolved');
    // The pressed notification now offers the next steps for a resolved ticket.
    const markup = JSON.stringify(telegram.last('editMessageReplyMarkup')?.payload.reply_markup);
    expect(markup).toContain(`tk:${number}:open`);
    expect(markup).toContain(`tk:${number}:closed`);
    expect(markup).not.toContain(`tk:${number}:resolved`);
    await bot.handleUpdate(callback(admin, `tk:${number}:open`, supergroup));
    expect((await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('open');
    expect(JSON.stringify(telegram.last('editMessageReplyMarkup')?.payload.reply_markup)).toContain(
      `tk:${number}:assign`,
    );

    // Commands in the topic need no ticket number.
    telegram.clear();
    await bot.handleUpdate(
      message(
        admin,
        { text: '/ticket', message_thread_id: threadId, is_topic_message: true },
        supergroup,
      ),
    );
    const detail = replies(telegram).at(-1)!;
    expect(detail).toContain(`#${number}`);
    expect(detail).toContain('Still blank');
  });

  it('lets admins work from private chat, and keeps users to their own tickets', async () => {
    const config: AppConfig = { ...base, ADMIN_IDS: [admin] };
    const { bot, telegram } = makeBot(config);
    await touchUser(db, person(other));
    const opened = await openTicket(
      db,
      other,
      next(),
      { text: 'Other ticket', attachment: null },
      [{ chatId: admin }],
      {
        requireAwaiting: false,
      },
    );
    if (opened.kind !== 'created') throw new Error('expected a ticket');

    await bot.handleUpdate(message(admin, { text: '/tickets all' }));
    expect(replies(telegram).at(-1)).toContain(`#${opened.number}`);
    await bot.handleUpdate(message(admin, { text: `/reply ${opened.number} Hello there` }));
    expect(replies(telegram).at(-1)).toContain(`#${opened.number}`);
    expect(
      await db.ticketMessage.count({ where: { ticketId: opened.ticketId, direction: 'outbound' } }),
    ).toBe(1);
    await bot.handleUpdate(callback(admin, 'tl:all:1'));
    expect(telegram.of('editMessageText').length).toBe(1);

    // Non-admins: operator commands are refused, /ticket shows only their own tickets.
    telegram.clear();
    await bot.handleUpdate(message(user, { text: `/reply ${opened.number} hijack` }));
    expect(replies(telegram).at(-1)).toContain('not authorized');
    await bot.handleUpdate(message(user, { text: `/ticket ${opened.number}` }));
    expect(replies(telegram).at(-1)).not.toContain('Other ticket');
    await bot.handleUpdate(message(other, { text: `/ticket ${opened.number}` }));
    expect(replies(telegram).at(-1)).toContain('Hello there');
    expect(
      await db.ticketMessage.count({ where: { ticketId: opened.ticketId, direction: 'outbound' } }),
    ).toBe(1);
  });

  it('answers status commands with the outcome and next-step buttons, and tells the user', async () => {
    const config: AppConfig = { ...base, ADMIN_IDS: [admin] };
    const { bot, telegram } = makeBot(config);
    await touchUser(db, person(other));
    const opened = await openTicket(
      db,
      other,
      next(),
      { text: 'The printer is on fire, please help', attachment: null },
      [],
      { requireAwaiting: false },
    );
    if (opened.kind !== 'created') throw new Error('expected a ticket');
    const n = opened.number;
    const last = () => telegram.last('sendMessage')!.payload;
    const buttons = () => JSON.stringify(last().reply_markup);

    await bot.handleUpdate(message(admin, { text: `/assign ${n}` }));
    expect(last().text).toBe(`Ticket #${n} → In progress`);
    expect(buttons()).toContain(`tk:${n}:resolved`);
    expect(buttons()).not.toContain(`tk:${n}:assign`);
    await bot.handleUpdate(message(admin, { text: `/assign ${n}` }));
    expect(last().text).toBe(`Ticket #${n} is already “In progress”; nothing changed.`);
    await bot.handleUpdate(message(admin, { text: `/set_status ${n} resolved` }));
    expect(last().text).toBe(`Ticket #${n} → Resolved`);
    expect(buttons()).toContain(`tk:${n}:open`);

    // The user hears about each real status change, starting with "someone is on it".
    const notices = await db.ticketMessage.findMany({
      where: { ticketId: opened.ticketId, authorId: 0n },
      orderBy: { createdAt: 'asc' },
    });
    expect(notices.map((m) => m.text)).toEqual([
      expect.stringContaining('started working on your ticket'),
      expect.stringContaining('marked as resolved'),
    ]);

    // Ticket views count and list only the conversation; the history shows the changes.
    await bot.handleUpdate(message(admin, { text: `/ticket ${n}` }));
    expect(last().text).toContain('Messages: 1 (latest 1 shown)');
    expect(last().text).not.toContain('started working');
    expect(buttons()).toContain(`tk:${n}:closed`);
    await bot.handleUpdate(message(other, { text: '/my_feedbacks' }));
    expect(last().text).toMatch(new RegExp(`#${n} · Resolved · .* · 1 messages`));

    // Search shows who wrote it and the words around the match.
    await bot.handleUpdate(message(admin, { text: '/search ON FIRE' }));
    expect(last().text).toContain(`#${n} [Resolved] User ${other} (${other})`);
    expect(last().text).toContain('The printer is on fire, please help');
  });

  it('continues a ticket in progress from a plain message, and offers to send anything else', async () => {
    const config: AppConfig = { ...base, ADMIN_IDS: [admin] };
    const { bot, telegram } = makeBot(config);
    const ticketsOf = (id: number) =>
      db.ticket.findMany({
        where: { user: { telegramId: BigInt(id) } },
        include: { messages: { orderBy: { createdAt: 'asc' } } },
      });

    // A message outside any ticket is not lost: the reply offers to send exactly that message.
    const hello = message(stranger, { text: 'Hello?' });
    await bot.handleUpdate(hello);
    const prompt = telegram.last('sendMessage')!.payload;
    expect(String(prompt.text)).toContain('Send this message to support?');
    expect(prompt.reply_parameters).toMatchObject({ message_id: hello.message!.message_id });
    expect(JSON.stringify(prompt.reply_markup)).toContain(`uf:new:${hello.update_id}`);
    expect(await ticketsOf(stranger)).toHaveLength(0);

    // One tap opens the ticket with that message; a double tap does not open a second one.
    const tap = () => bot.handleUpdate(offerTap(stranger, `uf:new:${hello.update_id}`, hello));
    await tap();
    expect(String(telegram.last('editMessageText')!.payload.text)).toMatch(/^Received: ticket #\d+/);
    await tap();
    const [ticket, ...extra] = await ticketsOf(stranger);
    expect(extra).toHaveLength(0);
    expect(ticket!.messages.map((m) => m.text)).toEqual(['Hello?']);
    expect(
      await db.delivery.count({ where: { chatId: BigInt(admin), messageId: ticket!.messages[0]!.id } }),
    ).toBe(1);

    await bot.handleUpdate(message(stranger, { text: 'One more detail' }));
    expect(replies(telegram).at(-1)).toContain(`#${ticket!.number}`);
    expect(await db.ticketMessage.count({ where: { ticketId: ticket!.id } })).toBe(2);
    // Admins are notified of the follow-up.
    expect(
      await db.delivery.count({
        where: {
          chatId: BigInt(admin),
          message: { ticketId: ticket!.id, text: 'One more detail' },
        },
      }),
    ).toBe(1);

    // Once resolved, a plain message does not reopen it implicitly ("thanks!"): the user picks.
    await db.ticket.update({
      where: { id: ticket!.id },
      data: { status: 'resolved', resolvedAt: new Date() },
    });
    const again = message(stranger, { text: 'It broke again' });
    await bot.handleUpdate(again);
    const choice = telegram.last('sendMessage')!.payload;
    expect(String(choice.text)).toContain(`#${ticket!.number} is resolved`);
    const add = `uf:add:${again.update_id}:${ticket!.number}`;
    expect(JSON.stringify(choice.reply_markup)).toContain(add);
    expect(JSON.stringify(choice.reply_markup)).toContain(`uf:new:${again.update_id}`);
    expect(await db.ticketMessage.count({ where: { ticketId: ticket!.id } })).toBe(2);
    await bot.handleUpdate(offerTap(stranger, add, again));
    expect(String(telegram.last('editMessageText')!.payload.text)).toContain(
      `Added to ticket #${ticket!.number}`,
    );
    const reopened = await db.ticket.findUniqueOrThrow({ where: { id: ticket!.id } });
    expect(reopened.status).toBe('open');
    expect(await db.ticketMessage.count({ where: { ticketId: ticket!.id } })).toBe(3);

    // Buttons cannot reach another user's ticket, or submit another user's message.
    const othersBefore = (await ticketsOf(other)).length;
    const mine = message(other, { text: 'Not yours' });
    await bot.handleUpdate(offerTap(other, `uf:add:${mine.update_id}:${ticket!.number}`, mine));
    expect(telegram.last('answerCallbackQuery')!.payload.text).toBe(
      'Ticket does not exist or was erased.',
    );
    await bot.handleUpdate(offerTap(other, `uf:new:${hello.update_id}`, hello));
    expect(String(telegram.last('answerCallbackQuery')!.payload.text)).toContain('expired');
    expect(await db.ticketMessage.count({ where: { ticketId: ticket!.id } })).toBe(3);
    expect(await ticketsOf(other)).toHaveLength(othersBefore);
  });

  it('bans by ticket number and silently ignores the banned user', async () => {
    const config: AppConfig = { ...base, ADMIN_IDS: [admin], INTAKE_MODE: 'direct' };
    const { bot, telegram } = makeBot(config);
    await bot.handleUpdate(message(other, { text: 'Spam one' }));
    const number = Number(/#(\d+)/.exec(replies(telegram).at(-1)!)?.[1]);
    await bot.handleUpdate(message(other, { text: 'Spam two' }));
    expect(replies(telegram).at(-1)).toContain(`#${number}`); // direct mode appends to the open ticket
    const ticket = await db.ticket.findUniqueOrThrow({ where: { number } });
    expect(
      await db.ticketMessage.count({ where: { ticketId: ticket.id, text: { startsWith: 'Spam' } } }),
    ).toBe(2);

    await bot.handleUpdate(message(admin, { text: `/ban #${number}` }));
    telegram.clear();
    await bot.handleUpdate(message(other, { text: 'Spam three' }));
    expect(telegram.calls).toHaveLength(0);
    await bot.handleUpdate(message(other, { text: '/my_data' }));
    expect(replies(telegram)).toHaveLength(1); // privacy commands stay available
    await bot.handleUpdate(message(admin, { text: `/unban ${other}` }));
    await bot.handleUpdate(message(admin, { text: `/ban ${admin}` }));
    expect(replies(telegram).at(-1)).toContain('not authorized');
    expect(
      (await db.telegramUser.findUniqueOrThrow({ where: { telegramId: BigInt(other) } })).bannedAt,
    ).toBeNull();
  });

  it('parks a reply to a user who blocked the bot and lets an operator retry it', async () => {
    const config: AppConfig = { ...base, ADMIN_IDS: [admin] };
    await touchUser(db, person(blockedUser));
    const opened = await openTicket(
      db,
      blockedUser,
      next(),
      { text: 'Blocked later', attachment: null },
      [],
      {
        requireAwaiting: false,
      },
    );
    if (opened.kind !== 'created') throw new Error('expected a ticket');
    const reply = await addStaffMessage(
      db,
      admin,
      next(),
      { id: opened.ticketId },
      { text: 'Answer', attachment: null },
    );
    if (reply.kind !== 'queued') throw new Error('expected a queued reply');
    const api = new Api(config.BOT_TOKEN);
    const blocked = recordingTelegram({
      fail: () => ({
        ok: false,
        error_code: 403,
        description: 'Forbidden: bot was blocked by the user',
      }),
    });
    api.config.use(blocked.transformer);
    const token = randomUUID();
    const row = await db.delivery.findFirstOrThrow({ where: { messageId: reply.messageId } });
    const claimed = await claimDeliveries(db, token, 500);
    for (const id of claimed)
      if (id === row.id)
        expect(await sendDelivery({ db, api, config, logger }, id, token)).toBe('blocked');
      else await releaseDelivery(db, id, token);

    const { bot, telegram } = makeBot(config);
    await bot.handleUpdate(message(admin, { text: '/deliveries' }));
    expect(replies(telegram).at(-1)).toContain(row.id);
    await bot.handleUpdate(message(admin, { text: `/delivery ${row.id} retry` }));
    expect((await db.delivery.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('pending');
  });

  it('deletes despite a failed callback acknowledgement and rejects replay after re-registration', async () => {
    await touchUser(db, person(user));
    const confirmation = await issueDeleteConfirmation(db, user, next(), base.BOT_TOKEN);
    const telegram = recordingTelegram({
      fail: (call) =>
        call.method === 'answerCallbackQuery'
          ? { ok: false, error_code: 400, description: 'query too old' }
          : undefined,
    });
    const { bot } = makeBot(base, telegram);
    const update = callback(user, confirmation);
    await bot.handleUpdate(update);
    expect(await db.telegramUser.count({ where: { telegramId: BigInt(user) } })).toBe(0);
    await touchUser(db, person(user));
    const opened = await openTicket(db, user, next(), { text: 'New life', attachment: null }, [], {
      requireAwaiting: false,
    });
    await bot.handleUpdate({ ...update, update_id: next() });
    expect(opened.kind).toBe('created');
    expect(await db.ticket.count({ where: { user: { telegramId: BigInt(user) } } })).toBe(1);
  });

  it('revokes a canceled nonce and refuses wrong-user confirmation', async () => {
    await touchUser(db, person(other));
    const confirmation = await issueDeleteConfirmation(db, user, next(), base.BOT_TOKEN);
    expect(await consumeDeleteConfirmation(db, other, confirmation, base.BOT_TOKEN)).toBe(false);
    await cancelDeleteConfirmation(db, user, confirmationNonce(confirmation));
    expect(await consumeDeleteConfirmation(db, user, confirmation, base.BOT_TOKEN)).toBe(false);
  });

  it('replays an authenticated webhook after a reply failure without undoing a later cancel', async () => {
    const webhookConfig: AppConfig = { ...base, BOT_MODE: 'webhook', WEBHOOK_SECRET: 'A'.repeat(48) };
    let fail = true;
    const telegram = recordingTelegram({
      fail: () =>
        fail ? { ok: false, error_code: 403, description: 'Synthetic reply failure' } : undefined,
    });
    const { bot } = makeBot(webhookConfig, telegram);
    const app = createServer({ config: webhookConfig, db, bot, logger });
    const request = {
      method: 'POST' as const,
      url: webhookConfig.WEBHOOK_PATH,
      headers: { 'x-telegram-bot-api-secret-token': webhookConfig.WEBHOOK_SECRET },
      payload: message(user, { text: '/feedback' }),
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

  it('exports only the requesting user, page by page', async () => {
    await touchUser(db, person(user));
    await touchUser(db, person(other));
    const mine = await openTicket(db, user, next(), { text: 'OWN 0', attachment: null }, [], {
      requireAwaiting: false,
    });
    if (mine.kind !== 'created') throw new Error('expected a ticket');
    await db.ticketMessage.createMany({
      data: Array.from({ length: 120 }, (_, i) => ({
        ticketId: mine.ticketId,
        direction: i % 2 ? ('outbound' as const) : ('inbound' as const),
        authorId: BigInt(i % 2 ? admin : user),
        text: `OWN ${i + 1}`,
      })),
    });
    await openTicket(db, other, next(), { text: 'DO_NOT_EXPORT', attachment: null }, [], {
      requireAwaiting: false,
    });
    const first = (await getPersonalDataExportPage(db, user))!;
    expect(first.count).toBe(100);
    const second = (await getPersonalDataExportPage(db, user, decodeExportCursor(first.nextCursor!)))!;
    expect(second.count).toBeGreaterThanOrEqual(21);
    expect(second.nextCursor).toBeNull();
    for (const page of [first, second])
      expect(page.fileContents.toString()).not.toContain('DO_NOT_EXPORT');
  });
});
