import type { Database } from './client.ts';
import { commandOnce, userMutation, type Transaction } from './commands.ts';
import { RECEIPT_RETENTION_MS } from '../config/constants.ts';
import type { MessageContent } from '../domain/content.ts';
import { parseTicketRef } from '../domain/feedback.ts';
import type { DeliveryStatus, Prisma, TicketStatus } from '../generated/prisma/client.ts';

export const TICKET_STATUSES = [
  'open',
  'in_progress',
  'resolved',
  'closed',
] as const satisfies readonly TicketStatus[];
export const DELIVERY_ACTIONS = ['retry', 'pause', 'dismiss'] as const;
export type DeliveryAction = (typeof DELIVERY_ACTIONS)[number];
export type StatusAction = TicketStatus | 'assign';

/** Where a message must be delivered. Admin targets are resolved from config by the caller. */
export type Recipient = { chatId: number | bigint };

/** Renders the optional "your ticket was resolved" notice in the ticket owner's language. */
export type StatusNotice = (
  language: string,
  ticketNumber: number,
  status: TicketStatus,
) => string | null;

const userIdOf = (telegramId: number) => BigInt(telegramId);

/** Status notices the bot sends on its own are stored with author 0. */
export const SYSTEM_AUTHOR = 0n;
/** Conversation messages only: excludes the bot's automatic status notices. */
const conversation = { authorId: { not: SYSTEM_AUTHOR } } satisfies Prisma.TicketMessageWhereInput;

function messageData(content: MessageContent) {
  return {
    text: content.text,
    attachmentType: content.attachment?.type ?? null,
    attachmentId: content.attachment?.fileId ?? null,
  };
}

function deliveriesFor(recipients: readonly Recipient[]) {
  // Deduplicate: an admin may also be the group chat in odd configurations.
  const chats = [...new Set(recipients.map((r) => BigInt(r.chatId)))];
  return { create: chats.map((chatId) => ({ chatId })) };
}

export function ticketWhere(ref: string): Prisma.TicketWhereUniqueInput | null {
  const parsed = parseTicketRef(ref);
  if (!parsed) return null;
  return 'number' in parsed ? { number: parsed.number } : { id: parsed.id };
}

/** True when Telegram's update sequence shows this update is older than the user's last state change. */
function staleUpdate(
  user: { lastStateUpdateId: number | null; lastStateUpdateAt: Date | null } | null,
  updateId: number,
): boolean {
  return Boolean(
    user?.lastStateUpdateId !== null &&
    user?.lastStateUpdateId !== undefined &&
    user.lastStateUpdateId > updateId &&
    user.lastStateUpdateAt &&
    Date.now() - user.lastStateUpdateAt.getTime() < RECEIPT_RETENTION_MS,
  );
}

export type OpenResult =
  | { kind: 'created' | 'appended' | 'duplicate'; ticketId: string; number: number; messageId: string }
  | { kind: 'not_awaiting' | 'stale' | 'missing' };

/**
 * Opens a ticket with the user's first message. Serialized per user and keyed by
 * the Telegram update ID, so webhook retries and concurrent duplicates are safe.
 * With `requireAwaiting`, the pending /feedback state is consumed atomically.
 */
export async function openTicket(
  db: Database,
  telegramId: number,
  updateId: number,
  content: MessageContent,
  recipients: readonly Recipient[],
  {
    requireAwaiting,
    sourceUpdateId = updateId,
  }: {
    requireAwaiting: boolean;
    /** The update that carried the message, when a later one (a button press) submits it. */
    sourceUpdateId?: number;
  },
): Promise<OpenResult> {
  return userMutation(db, telegramId, async (tx) => {
    const existing = await findByUpdate(tx, sourceUpdateId);
    if (existing) return existing;
    const user = await tx.telegramUser.findUnique({ where: { telegramId: userIdOf(telegramId) } });
    if (!user) return { kind: 'missing' };
    if (staleUpdate(user, updateId)) return { kind: 'stale' };
    if (requireAwaiting) {
      const claimed = await tx.telegramUser.updateMany({
        where: { id: user.id, awaitingFeedback: true, feedbackExpiresAt: { gt: new Date() } },
        data: { awaitingFeedback: false, feedbackExpiresAt: null },
      });
      if (claimed.count === 0) return { kind: 'not_awaiting' };
    }
    await tx.telegramUser.update({
      where: { id: user.id },
      data: { lastStateUpdateId: updateId, lastStateUpdateAt: new Date() },
    });
    const ticket = await tx.ticket.create({
      data: {
        userId: user.id,
        messages: {
          create: {
            direction: 'inbound',
            authorId: userIdOf(telegramId),
            sourceUpdateId,
            ...messageData(content),
            deliveries: deliveriesFor(recipients),
          },
        },
      },
      select: { id: true, number: true, messages: { select: { id: true } } },
    });
    return {
      kind: 'created',
      ticketId: ticket.id,
      number: ticket.number,
      messageId: ticket.messages[0]!.id,
    };
  });
}

async function findByUpdate(tx: Transaction, updateId: number): Promise<OpenResult | null> {
  const message = await tx.ticketMessage.findUnique({
    where: { sourceUpdateId: updateId },
    select: { id: true, ticket: { select: { id: true, number: true } } },
  });
  return message
    ? {
        kind: 'duplicate',
        ticketId: message.ticket.id,
        number: message.ticket.number,
        messageId: message.id,
      }
    : null;
}

/**
 * Adds a user's follow-up to one of their own tickets. A resolved or closed ticket
 * is reopened: the user clearly still needs help.
 */
export async function addUserMessage(
  db: Database,
  telegramId: number,
  updateId: number,
  ticketId: string,
  content: MessageContent,
  recipients: readonly Recipient[],
  sourceUpdateId = updateId,
): Promise<OpenResult> {
  return userMutation(db, telegramId, async (tx) => {
    const existing = await findByUpdate(tx, sourceUpdateId);
    if (existing) return existing;
    const ticket = await tx.ticket.findFirst({
      where: { id: ticketId, user: { telegramId: userIdOf(telegramId) } },
      select: { id: true, number: true, status: true },
    });
    if (!ticket) return { kind: 'missing' };
    const now = new Date();
    const reopen = ticket.status === 'resolved' || ticket.status === 'closed';
    await tx.ticket.update({
      where: { id: ticket.id },
      data: { lastMessageAt: now, ...(reopen ? { status: 'open', resolvedAt: null } : {}) },
    });
    if (reopen)
      await tx.ticketEvent.create({
        data: { ticketId: ticket.id, action: 'reopened_by_user', actorId: userIdOf(telegramId) },
      });
    const message = await tx.ticketMessage.create({
      data: {
        ticketId: ticket.id,
        direction: 'inbound',
        authorId: userIdOf(telegramId),
        sourceUpdateId,
        ...messageData(content),
        deliveries: deliveriesFor(recipients),
      },
      select: { id: true },
    });
    return { kind: 'appended', ticketId: ticket.id, number: ticket.number, messageId: message.id };
  });
}

/** The user's most recent ticket that is still being worked on (direct intake mode). */
export function latestActiveTicket(db: Database, telegramId: number) {
  return db.ticket.findFirst({
    where: { user: { telegramId: userIdOf(telegramId) }, status: { in: ['open', 'in_progress'] } },
    orderBy: { lastMessageAt: 'desc' },
    select: { id: true, number: true },
  });
}

/** The user's latest ticket resolved within `withinMs`: a new message may well be about it. */
export function recentlyResolvedTicket(db: Database, telegramId: number, withinMs: number) {
  return db.ticket.findFirst({
    where: {
      user: { telegramId: userIdOf(telegramId) },
      status: 'resolved',
      resolvedAt: { gt: new Date(Date.now() - withinMs) },
    },
    orderBy: { resolvedAt: 'desc' },
    select: { id: true, number: true },
  });
}

/** One of the user's own tickets by number, or null. */
export function ownTicket(db: Database, telegramId: number, number: number) {
  return db.ticket.findFirst({
    where: { number, user: { telegramId: userIdOf(telegramId) } },
    select: { id: true, number: true, status: true },
  });
}

export type StaffReplyResult =
  | { kind: 'queued' | 'duplicate'; ticketId: string; number: number; messageId: string }
  | { kind: 'missing' }
  | { kind: 'closed' };

/**
 * Queues a support reply to the ticket owner. Idempotent per Telegram update; the
 * first reply on an open ticket also assigns it to the replying operator.
 */
export async function addStaffMessage(
  db: Database,
  actorId: number,
  updateId: number,
  where: Prisma.TicketWhereUniqueInput,
  content: MessageContent,
): Promise<StaffReplyResult> {
  try {
    return await insertStaffMessage(db, actorId, updateId, where, content);
  } catch (error) {
    // A concurrent duplicate of the same update won the unique sourceUpdateId race.
    if (!isUniqueViolation(error)) throw error;
    const existing = await findByUpdate(db as unknown as Transaction, updateId);
    if (existing?.kind === 'duplicate') return { ...existing, kind: 'duplicate' };
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

async function insertStaffMessage(
  db: Database,
  actorId: number,
  updateId: number,
  where: Prisma.TicketWhereUniqueInput,
  content: MessageContent,
): Promise<StaffReplyResult> {
  return db.$transaction(async (tx) => {
    const existing = await findByUpdate(tx, updateId);
    if (existing && existing.kind === 'duplicate') return { ...existing, kind: 'duplicate' as const };
    const ticket = await tx.ticket.findUnique({
      where,
      select: {
        id: true,
        number: true,
        status: true,
        assignedTo: true,
        user: { select: { telegramId: true } },
      },
    });
    if (!ticket) return { kind: 'missing' as const };
    if (ticket.status === 'closed') return { kind: 'closed' as const };
    await tx.ticket.update({
      where: { id: ticket.id },
      data: {
        lastMessageAt: new Date(),
        ...(ticket.status === 'open' ? { status: 'in_progress' } : {}),
        ...(ticket.assignedTo === null ? { assignedTo: BigInt(actorId) } : {}),
      },
    });
    const message = await tx.ticketMessage.create({
      data: {
        ticketId: ticket.id,
        direction: 'outbound',
        authorId: BigInt(actorId),
        sourceUpdateId: updateId,
        ...messageData(content),
        deliveries: { create: { chatId: ticket.user.telegramId } },
      },
      select: { id: true },
    });
    await tx.ticketEvent.create({
      data: { ticketId: ticket.id, action: 'reply', actorId: BigInt(actorId) },
    });
    return {
      kind: 'queued' as const,
      ticketId: ticket.id,
      number: ticket.number,
      messageId: message.id,
    };
  });
}

/**
 * Changes status or assignment, once per Telegram update (receipt-backed), with an
 * audit event and, when configured, a localized notice to the ticket owner. With
 * `onlyFrom`, a ticket whose current status it rejects is left alone and the result is
 * 'stale': a button pressed on an outdated message must not undo a later change.
 */
export async function changeTicket(
  db: Database,
  actor: number,
  updateId: number,
  ref: string | Prisma.TicketWhereUniqueInput,
  action: StatusAction,
  notice?: StatusNotice,
  onlyFrom?: (status: TicketStatus) => boolean,
): Promise<'saved' | 'missing' | 'unchanged' | 'stale'> {
  const where = typeof ref === 'string' ? ticketWhere(ref) : ref;
  if (!where) return 'missing';
  const result = await commandOnce(db, actor, updateId, async (tx) => {
    const ticket = await tx.ticket.findUnique({
      where,
      select: {
        id: true,
        number: true,
        status: true,
        assignedTo: true,
        user: { select: { telegramId: true, language: true } },
      },
    });
    if (!ticket) return 'missing';
    if (onlyFrom && !onlyFrom(ticket.status)) return 'stale';
    const status: TicketStatus =
      action === 'assign' ? (ticket.status === 'open' ? 'in_progress' : ticket.status) : action;
    if (action !== 'assign' && ticket.status === status) return 'unchanged';
    if (action === 'assign' && ticket.assignedTo === BigInt(actor) && ticket.status === status)
      return 'unchanged';
    await tx.ticket.update({
      where: { id: ticket.id },
      data: {
        status,
        ...(action === 'assign' ? { assignedTo: BigInt(actor) } : {}),
        resolvedAt: status === 'resolved' || status === 'closed' ? new Date() : null,
      },
    });
    await tx.ticketEvent.create({
      data: { ticketId: ticket.id, actorId: BigInt(actor), sourceUpdateId: updateId, action },
    });
    // Tell the owner whenever the status really changed (a reassignment alone is internal).
    const text = status === ticket.status ? null : notice?.(ticket.user.language, ticket.number, status);
    if (text)
      await tx.ticketMessage.create({
        data: {
          ticketId: ticket.id,
          direction: 'outbound',
          authorId: SYSTEM_AUTHOR,
          text,
          deliveries: { create: { chatId: ticket.user.telegramId } },
        },
      });
    return 'saved';
  });
  return result as 'saved' | 'missing' | 'unchanged' | 'stale';
}

/** Operator control of one outbox row. Refuses to touch a row that is being sent right now. */
export async function controlDelivery(
  db: Database,
  actor: number,
  updateId: number,
  deliveryId: string,
  action: DeliveryAction,
): Promise<'saved' | 'missing' | 'already_sent' | 'busy' | 'stale'> {
  const result = await commandOnce(db, actor, updateId, async (tx) => {
    const found = await tx.delivery.findUnique({
      where: { id: deliveryId },
      select: {
        status: true,
        leaseToken: true,
        leaseUntil: true,
        message: { select: { ticketId: true } },
      },
    });
    if (!found) return 'missing';
    if (found.status === 'sent') return 'already_sent';
    const now = new Date();
    if (found.leaseToken && found.leaseUntil && found.leaseUntil > now) return 'busy';
    const status: DeliveryStatus =
      action === 'retry' ? 'pending' : action === 'pause' ? 'paused' : 'dismissed';
    const updated = await tx.delivery.updateMany({
      where: {
        id: deliveryId,
        OR: [{ leaseToken: null }, { leaseUntil: null }, { leaseUntil: { lte: now } }],
      },
      data: {
        status,
        leaseToken: null,
        leaseUntil: null,
        ...(action === 'retry' ? { lastErrorCode: null } : {}),
      },
    });
    if (!updated.count) return 'busy';
    await tx.ticketEvent.create({
      data: {
        ticketId: found.message.ticketId,
        actorId: BigInt(actor),
        sourceUpdateId: updateId,
        action: `delivery_${action}`,
      },
    });
    return 'saved';
  });
  return result as 'saved' | 'missing' | 'already_sent' | 'busy' | 'stale';
}

// ── Queries ──────────────────────────────────────────────────────────────────

export const TICKET_PAGE_SIZE = 8;

export async function listTickets(
  db: Database,
  {
    status,
    offset = 0,
    limit = TICKET_PAGE_SIZE,
  }: { status?: TicketStatus | 'active'; offset?: number; limit?: number },
) {
  const where: Prisma.TicketWhereInput =
    status === 'active' ? { status: { in: ['open', 'in_progress'] } } : status ? { status } : {};
  const [total, rows] = await Promise.all([
    db.ticket.count({ where }),
    db.ticket.findMany({
      where,
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      skip: offset,
      take: limit,
      select: {
        id: true,
        number: true,
        status: true,
        lastMessageAt: true,
        user: { select: { telegramId: true, username: true, firstName: true } },
        messages: {
          orderBy: { createdAt: 'asc' },
          take: 1,
          select: { text: true, attachmentType: true },
        },
      },
    }),
  ]);
  return { total, rows };
}

/** Case-insensitive search in conversation text; bounded, newest first, with the latest match. */
export async function searchTickets(db: Database, query: string, limit = 10) {
  const match = {
    ...conversation,
    text: { contains: query, mode: 'insensitive' },
  } satisfies Prisma.TicketMessageWhereInput;
  return db.ticket.findMany({
    where: { messages: { some: match } },
    orderBy: { lastMessageAt: 'desc' },
    take: limit,
    select: {
      id: true,
      number: true,
      status: true,
      lastMessageAt: true,
      user: { select: { telegramId: true, username: true, firstName: true } },
      messages: {
        where: match,
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { text: true },
      },
    },
  });
}

export function getTicket(db: Database, where: Prisma.TicketWhereUniqueInput, messageLimit = 10) {
  return db.ticket.findUnique({
    where,
    include: {
      user: { select: { telegramId: true, username: true, firstName: true, bannedAt: true } },
      messages: {
        where: conversation,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: messageLimit,
        include: {
          deliveries: { select: { id: true, status: true, lastErrorCode: true, attempts: true } },
        },
      },
      events: { orderBy: { createdAt: 'desc' }, take: 10 },
      _count: { select: { messages: { where: conversation } } },
    },
  });
}

export function myTickets(db: Database, telegramId: number, limit = 10) {
  return db.ticket.findMany({
    where: { user: { telegramId: userIdOf(telegramId) } },
    orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
    take: limit,
    select: {
      id: true,
      number: true,
      status: true,
      createdAt: true,
      lastMessageAt: true,
      _count: { select: { messages: { where: conversation } } },
    },
  });
}

/** Maps a reply to a bot message back to its ticket (in admin chats and user chats alike). */
export async function ticketForDeliveredMessage(db: Database, chatId: number, messageId: number) {
  const delivery = await db.delivery.findFirst({
    where: {
      chatId: BigInt(chatId),
      OR: [{ sentMessageId: messageId }, { sentHeaderMessageId: messageId }],
    },
    select: { message: { select: { ticket: { select: { id: true, number: true, status: true } } } } },
  });
  return delivery?.message.ticket ?? null;
}

export function ticketForThread(db: Database, threadId: number) {
  return db.ticket.findFirst({
    where: { adminThreadId: threadId },
    select: { id: true, number: true, status: true },
  });
}

export async function ticketOwner(db: Database, where: Prisma.TicketWhereUniqueInput) {
  const ticket = await db.ticket.findUnique({
    where,
    select: { user: { select: { telegramId: true } } },
  });
  return ticket ? Number(ticket.user.telegramId) : null;
}

export function listDeliveryProblems(db: Database, limit = 15) {
  return db.delivery.findMany({
    where: { status: { in: ['blocked', 'paused'] } },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: {
      id: true,
      chatId: true,
      status: true,
      lastErrorCode: true,
      attempts: true,
      message: { select: { direction: true, ticket: { select: { number: true } } } },
    },
  });
}

export async function countStats(db: Database) {
  const [users, banned, byStatus, pending] = await Promise.all([
    db.telegramUser.count(),
    db.telegramUser.count({ where: { bannedAt: { not: null } } }),
    db.ticket.groupBy({ by: ['status'], _count: { _all: true } }),
    db.delivery.count({ where: { status: 'pending' } }),
  ]);
  const tickets = Object.fromEntries(TICKET_STATUSES.map((s) => [s, 0])) as Record<TicketStatus, number>;
  for (const row of byStatus) tickets[row.status] = row._count._all;
  return { users, banned, tickets, pending };
}
