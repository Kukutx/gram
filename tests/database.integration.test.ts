import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomInt, randomUUID } from 'node:crypto';
import { createPrisma, type Database } from '../src/db/client.ts';
import { parseConfig } from '../src/config/env.ts';
import { beginFeedback, deleteMyData, expireFeedback, touchUser } from '../src/db/users.ts';
import {
  addStaffMessage,
  addUserMessage,
  changeTicket,
  controlDelivery,
  countStats,
  openTicket,
  ticketForDeliveredMessage,
  type StatusNotice,
} from '../src/db/tickets.ts';
import {
  claimDeliveries,
  expandLegacyAdminDeliveries,
  markFailed,
  markSent,
  releaseDelivery,
} from '../src/db/outbox.ts';
import { purgeExpiredTickets } from '../src/maintenance/retention.ts';

// Set TEST_DATABASE_URL to a disposable, migrated PostgreSQL database to run this suite.
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
let db: Database;
const user = randomInt(800_000_000, 900_000_000);
const staff = user + 1;
const adminChat = -randomInt(1_000_000_000, 2_000_000_000);
let seq = randomInt(100_000_000, 200_000_000);
const next = () => ++seq;
const text = (value: string) => ({ text: value, attachment: null });
const recipients = [{ chatId: adminChat }];
const notice: StatusNotice = (_language, number, status) => `#${number} is now ${status}`;

/** Claims only this suite's rows: anything else that happens to be due is handed straight back. */
async function claimMine(token: string, ids: ReadonlySet<string>, limit = 500) {
  const claimed = await claimDeliveries(db, token, limit);
  const others = claimed.filter((id) => !ids.has(id));
  await Promise.all(others.map((id) => releaseDelivery(db, id, token)));
  return claimed.filter((id) => ids.has(id));
}

async function deliveryIds(chatId: number) {
  const rows = await db.delivery.findMany({ where: { chatId: BigInt(chatId) }, select: { id: true } });
  return new Set(rows.map((row) => row.id));
}

integration('ticket model on PostgreSQL', () => {
  beforeAll(async () => {
    db = createPrisma(
      parseConfig({
        BOT_TOKEN: '123456789:AAAAAAAAAAAAAAA',
        DATABASE_URL: process.env.TEST_DATABASE_URL,
      }),
    );
    await db.$connect();
    await touchUser(db, { id: user, is_bot: false, first_name: 'Synthetic' });
  });
  afterAll(async () => {
    await deleteMyData(db, user);
    await db.delivery.deleteMany({
      where: { chatId: { in: [BigInt(adminChat), BigInt(adminChat - 1)] } },
    });
    await db.$disconnect();
  });

  it('does not let delayed expiration cleanup cancel a newly started feedback', async () => {
    await db.telegramUser.update({
      where: { telegramId: BigInt(user) },
      data: { awaitingFeedback: true, feedbackExpiresAt: new Date(Date.now() - 60_000) },
    });
    await beginFeedback(db, user); // a concurrent /feedback arrived first
    expect(await expireFeedback(db, user)).toBe(false);
  });

  it('opens exactly one ticket for concurrent duplicates of one update', async () => {
    await beginFeedback(db, user, next());
    const update = next();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        openTicket(db, user, update, text('Concurrent'), recipients, { requireAwaiting: true }),
      ),
    );
    const created = results.filter((r) => r.kind === 'created');
    expect(created).toHaveLength(1);
    expect(results.every((r) => r.kind === 'created' || r.kind === 'duplicate')).toBe(true);
    expect(new Set(results.map((r) => ('ticketId' in r ? r.ticketId : null))).size).toBe(1);
    // The pending /feedback was consumed, so a different update cannot open another ticket.
    expect(
      (await openTicket(db, user, next(), text('Late'), recipients, { requireAwaiting: true })).kind,
    ).toBe('not_awaiting');
  });

  it('numbers tickets sequentially and fans each message out to every recipient once', async () => {
    const two = [{ chatId: adminChat }, { chatId: adminChat - 1 }, { chatId: adminChat }];
    const a = await openTicket(db, user, next(), text('A'), two, { requireAwaiting: false });
    const b = await openTicket(db, user, next(), text('B'), two, { requireAwaiting: false });
    if (a.kind !== 'created' || b.kind !== 'created') throw new Error('expected new tickets');
    expect(b.number).toBeGreaterThan(a.number);
    expect(await db.delivery.count({ where: { messageId: a.messageId } })).toBe(2);
  });

  it('runs the support conversation: staff reply, status notices, user reopen', async () => {
    const opened = await openTicket(db, user, next(), text('Help'), recipients, {
      requireAwaiting: false,
    });
    if (opened.kind !== 'created') throw new Error('expected a ticket');
    const where = { id: opened.ticketId };

    const reply = next();
    const queued = await addStaffMessage(db, staff, reply, where, text('On it'));
    expect(queued.kind).toBe('queued');
    expect((await addStaffMessage(db, staff, reply, where, text('On it'))).kind).toBe('duplicate');
    let ticket = await db.ticket.findUniqueOrThrow({ where });
    expect(ticket.status).toBe('in_progress');
    expect(ticket.assignedTo).toBe(BigInt(staff));
    expect(
      await db.delivery.count({ where: { chatId: BigInt(user), message: { ticketId: ticket.id } } }),
    ).toBe(1);

    const resolve = next();
    expect(await changeTicket(db, staff, resolve, where, 'resolved', notice)).toBe('saved');
    expect(await changeTicket(db, staff, resolve, where, 'resolved', notice)).toBe('saved'); // receipt replay
    expect(await changeTicket(db, staff, next(), where, 'resolved', notice)).toBe('unchanged');
    const system = await db.ticketMessage.findFirstOrThrow({
      where: { ticketId: ticket.id, authorId: 0n },
    });
    expect(system.text).toBe(`#${ticket.number} is now resolved`);

    // A follow-up from the user reopens the ticket and is routed back to staff.
    const follow = await addUserMessage(db, user, next(), ticket.id, text('Still broken'), recipients);
    expect(follow.kind).toBe('appended');
    ticket = await db.ticket.findUniqueOrThrow({ where });
    expect(ticket.status).toBe('open');
    expect(ticket.resolvedAt).toBeNull();
    expect(
      await db.ticketEvent.count({ where: { ticketId: ticket.id, action: 'reopened_by_user' } }),
    ).toBe(1);

    expect(await changeTicket(db, staff, next(), { number: ticket.number }, 'closed')).toBe('saved');
    expect((await addStaffMessage(db, staff, next(), where, text('late'))).kind).toBe('closed');
    expect(await changeTicket(db, staff, next(), '#999999999', 'closed')).toBe('missing');
  });

  it('claims one head per chat, in order, and parks permanent failures', async () => {
    const chat = adminChat - 1;
    await db.delivery.deleteMany({ where: { chatId: BigInt(chat) } });
    const opened = await openTicket(db, user, next(), text('first'), [{ chatId: chat }], {
      requireAwaiting: false,
    });
    if (opened.kind !== 'created') throw new Error('expected a ticket');
    await addUserMessage(db, user, next(), opened.ticketId, text('second'), [{ chatId: chat }]);
    const mine = await deliveryIds(chat);
    expect(mine.size).toBe(2);

    const [t1, t2] = [randomUUID(), randomUUID()];
    const first = await claimMine(t1, mine);
    expect(first).toHaveLength(1); // the second message waits behind the first
    expect(await claimMine(t2, mine)).toHaveLength(0); // leased: no double send
    expect(await markSent(db, first[0]!, t2, { messageId: 1 })).toBe(false); // wrong token
    expect(await markSent(db, first[0]!, t1, { messageId: 501 })).toBe(true);
    expect((await ticketForDeliveredMessage(db, chat, 501))?.id).toBe(opened.ticketId);

    const t3 = randomUUID();
    const second = await claimMine(t3, mine);
    expect(second).toHaveLength(1);
    expect(second[0]).not.toBe(first[0]);
    expect(await markFailed(db, second[0]!, t3, { code: 500, permanent: false, attempts: 1 })).toBe(
      'retry',
    );
    expect(await claimMine(randomUUID(), mine)).toHaveLength(0); // backoff not yet elapsed

    const row = await db.delivery.findUniqueOrThrow({ where: { id: second[0]! } });
    expect(row.status).toBe('pending');
    expect(row.leaseUntil!.getTime()).toBeGreaterThan(Date.now());
    await db.delivery.update({ where: { id: row.id }, data: { leaseUntil: new Date(Date.now() - 1) } });
    const t4 = randomUUID();
    expect(await claimMine(t4, mine)).toEqual([row.id]);
    expect(await markFailed(db, row.id, t4, { code: 403, permanent: true, attempts: 2 })).toBe(
      'blocked',
    );

    // Operators can retry a parked row; a sent row is left alone.
    expect(await controlDelivery(db, staff, next(), row.id, 'retry')).toBe('saved');
    expect((await db.delivery.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('pending');
    expect(await controlDelivery(db, staff, next(), first[0]!, 'dismiss')).toBe('already_sent');
    expect((await countStats(db)).pending).toBeGreaterThanOrEqual(1);
  });

  it('fans v1 admin notices on chat 0 out to the configured recipients', async () => {
    const opened = await openTicket(db, user, next(), text('legacy'), [{ chatId: 0 }], {
      requireAwaiting: false,
    });
    if (opened.kind !== 'created') throw new Error('expected a ticket');
    expect(await expandLegacyAdminDeliveries(db, [adminChat])).toBeGreaterThanOrEqual(1);
    expect(await db.delivery.count({ where: { messageId: opened.messageId, chatId: 0n } })).toBe(0);
    expect(
      await db.delivery.count({ where: { messageId: opened.messageId, chatId: BigInt(adminChat) } }),
    ).toBe(1);
  });

  it('purges inactive tickets and cascades erasure', async () => {
    const opened = await openTicket(db, user, next(), text('old'), recipients, {
      requireAwaiting: false,
    });
    if (opened.kind !== 'created') throw new Error('expected a ticket');
    await db.ticket.update({
      where: { id: opened.ticketId },
      data: { lastMessageAt: new Date(Date.now() - 40 * 86_400_000) },
    });
    expect(await purgeExpiredTickets(db, 30)).toBeGreaterThanOrEqual(1);
    expect(await db.ticket.count({ where: { id: opened.ticketId } })).toBe(0);
    expect(await db.ticketMessage.count({ where: { id: opened.messageId } })).toBe(0);

    await deleteMyData(db, user);
    expect(await db.ticket.count({ where: { user: { telegramId: BigInt(user) } } })).toBe(0);
    await touchUser(db, { id: user, is_bot: false, first_name: 'Synthetic' });
  });
});
