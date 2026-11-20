import type { Database } from './client.ts';
import { Prisma } from '../generated/prisma/client.ts';

/**
 * PostgreSQL transactional outbox for every message the bot sends.
 *
 * Claiming takes, per recipient chat, only the OLDEST pending row and only when it
 * is due. That keeps messages to one chat in order (a failing row holds back later
 * ones until it is sent, parked or dismissed) while different chats are sent in
 * parallel by any number of workers. Leases make concurrent workers safe; they
 * cannot make Telegram's API exactly-once after a crash between send and confirm.
 */
export const DELIVERY_LEASE_MS = 5 * 60_000;
export const RETRY_BASE_MS = 10_000;
export const RETRY_MAX_MS = 60 * 60_000;
/** After this many temporary failures a row is parked as blocked for an operator. */
export const MAX_TEMPORARY_ATTEMPTS = 12;

export function retryDelayMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(16, Math.trunc(attempts) - 1));
  return Math.min(RETRY_BASE_MS * 2 ** exponent, RETRY_MAX_MS);
}

/** Prisma stores DateTime as UTC `timestamp(3)`; compare raw parameters in UTC whatever the session TimeZone. */
const utc = (date: Date) => Prisma.sql`(${date.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

/** Leases up to `limit` due deliveries, at most one per chat. Returns their IDs. */
export async function claimDeliveries(
  db: Database,
  token: string,
  limit: number,
  now: Date = new Date(),
): Promise<string[]> {
  const leaseUntil = new Date(now.getTime() + DELIVERY_LEASE_MS);
  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    WITH heads AS (
      SELECT DISTINCT ON ("chatId") "id", "leaseUntil", "createdAt"
      FROM "Delivery"
      WHERE "status" = 'pending'
      ORDER BY "chatId", "createdAt", "id"
    ), due AS (
      SELECT "id" FROM heads
      WHERE "leaseUntil" IS NULL OR "leaseUntil" <= ${utc(now)}
      ORDER BY "createdAt"
      LIMIT ${limit}
    )
    UPDATE "Delivery" d
    SET "leaseToken" = ${token}, "leaseUntil" = ${utc(leaseUntil)}, "attempts" = d."attempts" + 1
    FROM due
    WHERE d."id" = due."id"
      AND d."status" = 'pending'
      AND (d."leaseUntil" IS NULL OR d."leaseUntil" <= ${utc(now)})
    RETURNING d."id"`);
  return rows.map((row) => row.id);
}

export function loadDelivery(db: Database, id: string) {
  return db.delivery.findUnique({
    where: { id },
    include: {
      message: {
        include: {
          ticket: {
            select: {
              id: true,
              number: true,
              status: true,
              adminThreadId: true,
              createdAt: true,
              user: { select: { telegramId: true, username: true, firstName: true, language: true } },
              _count: { select: { messages: { where: { direction: 'inbound' } } } },
            },
          },
        },
      },
    },
  });
}
export type LoadedDelivery = NonNullable<Awaited<ReturnType<typeof loadDelivery>>>;

export async function markSent(
  db: Database,
  id: string,
  token: string,
  sent: { messageId: number; headerMessageId?: number | undefined; threadId?: number | undefined },
  now: Date = new Date(),
): Promise<boolean> {
  const updated = await db.delivery.updateMany({
    where: { id, leaseToken: token, status: 'pending' },
    data: {
      status: 'sent',
      sentAt: now,
      sentMessageId: sent.messageId,
      sentHeaderMessageId: sent.headerMessageId ?? null,
      threadId: sent.threadId ?? null,
      leaseToken: null,
      leaseUntil: null,
      lastErrorCode: null,
    },
  });
  return updated.count === 1;
}

/**
 * Permanent errors (and too many temporary ones) park the row as `blocked`;
 * otherwise it stays pending with an exponential, durable backoff.
 */
export async function markFailed(
  db: Database,
  id: string,
  token: string,
  failure: { code: number | null; permanent: boolean; attempts: number; retryAfterMs?: number },
  now: Date = new Date(),
): Promise<'blocked' | 'retry'> {
  const blocked = failure.permanent || failure.attempts >= MAX_TEMPORARY_ATTEMPTS;
  // Flood control names its own wait; retrying sooner only extends the ban.
  const delay = Math.max(retryDelayMs(failure.attempts), failure.retryAfterMs ?? 0);
  await db.delivery.updateMany({
    where: { id, leaseToken: token },
    data: {
      status: blocked ? 'blocked' : 'pending',
      lastErrorCode: failure.code,
      lastErrorAt: now,
      leaseToken: null,
      leaseUntil: blocked ? null : new Date(now.getTime() + delay),
    },
  });
  return blocked ? 'blocked' : 'retry';
}

/** Gives the row back without counting it as a failure (e.g. shutdown before sending). */
export async function releaseDelivery(db: Database, id: string, token: string): Promise<void> {
  await db.delivery.updateMany({
    where: { id, leaseToken: token, status: 'pending' },
    data: { leaseToken: null, leaseUntil: null, attempts: { decrement: 1 } },
  });
}

/** Stores the forum topic created for a ticket; first writer wins. */
export async function setTicketThread(
  db: Database,
  ticketId: string,
  threadId: number | null,
): Promise<void> {
  await db.ticket.updateMany({
    where: threadId === null ? { id: ticketId } : { id: ticketId, adminThreadId: null },
    data: { adminThreadId: threadId },
  });
}

/**
 * v1 → v2 migration parks undelivered admin notices on chat 0 because the admin
 * ID lives in configuration. Fan them out to today's recipients exactly once.
 */
export async function expandLegacyAdminDeliveries(
  db: Database,
  recipients: readonly number[],
): Promise<number> {
  if (recipients.length === 0) return 0;
  return db.$transaction(async (tx) => {
    const legacy = await tx.delivery.findMany({
      where: { chatId: 0n },
      select: {
        id: true,
        messageId: true,
        status: true,
        attempts: true,
        lastErrorCode: true,
        createdAt: true,
      },
    });
    if (legacy.length === 0) return 0;
    await tx.delivery.createMany({
      data: legacy.flatMap((row) =>
        recipients.map((chatId) => ({
          messageId: row.messageId,
          chatId: BigInt(chatId),
          status: row.status,
          attempts: row.attempts,
          lastErrorCode: row.lastErrorCode,
          createdAt: row.createdAt,
        })),
      ),
      skipDuplicates: true,
    });
    await tx.delivery.deleteMany({ where: { id: { in: legacy.map((row) => row.id) } } });
    return legacy.length;
  });
}
