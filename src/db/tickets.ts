import type { Database } from './client.ts';
import { commandOnce } from './commands.ts';

export const TICKET_STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const DELIVERY_ACTIONS = ['retry', 'pause', 'dismiss'] as const;
export type DeliveryAction = (typeof DELIVERY_ACTIONS)[number];

export function validTicketId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

export function getTicket(db: Database, id: string) {
  return db.feedback.findUnique({
    where: { id },
    include: {
      user: { select: { telegramId: true, username: true } },
      replies: { orderBy: { createdAt: 'desc' }, take: 5 },
      events: { orderBy: { createdAt: 'desc' }, take: 10 },
    },
  });
}

export function myTickets(db: Database, telegramId: number) {
  return db.feedback.findMany({
    where: { user: { telegramId: BigInt(telegramId) } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 10,
    select: { id: true, status: true, createdAt: true, _count: { select: { replies: true } } },
  });
}

export async function changeTicket(
  db: Database,
  actor: number,
  updateId: number,
  id: string,
  action: TicketStatus | 'assign',
): Promise<string> {
  return commandOnce(db, actor, updateId, async (tx) => {
    const found = await tx.feedback.updateMany({
      where: { id },
      data:
        action === 'assign'
          ? { assignedTo: BigInt(actor), status: 'in_progress', resolvedAt: null }
          : { status: action, resolvedAt: ['resolved', 'closed'].includes(action) ? new Date() : null },
    });
    if (!found.count) return 'missing';
    await tx.feedbackEvent.create({
      data: { feedbackId: id, actorId: BigInt(actor), sourceUpdateId: updateId, action },
    });
    return 'saved';
  });
}

export async function queueReply(
  db: Database,
  actor: number,
  updateId: number,
  id: string,
  text: string,
): Promise<string> {
  return commandOnce(db, actor, updateId, async (tx) => {
    const feedback = await tx.feedback.findUnique({ where: { id } });
    if (!feedback) return 'missing';
    if (feedback.status === 'closed') return 'closed';
    const reply = await tx.feedbackReply.create({
      data: { feedbackId: id, sourceUpdateId: updateId, text },
    });
    await tx.feedbackEvent.create({
      data: { feedbackId: id, actorId: BigInt(actor), sourceUpdateId: updateId, action: 'reply_queued' },
    });
    return reply.id;
  });
}

/** Refuse to change an active lease; old queue jobs still consult this DB status. */
export async function controlDelivery(
  db: Database,
  actor: number,
  updateId: number,
  id: string,
  action: DeliveryAction,
  kind: 'feedback' | 'reply' = 'feedback',
): Promise<string> {
  return commandOnce(db, actor, updateId, async (tx) => {
    const query = {
      where: { id },
      select: { deliveryLeaseUntil: true, deliveryLeaseToken: true, notifiedAt: true },
    } as const;
    const found =
      kind === 'feedback'
        ? await tx.feedback.findUnique(query)
        : await tx.feedbackReply.findUnique(query);
    if (!found) return 'missing';
    if (found.notifiedAt) return 'already_sent';
    if (found.deliveryLeaseToken && found.deliveryLeaseUntil && found.deliveryLeaseUntil > new Date())
      return 'busy';
    const change = {
      where: {
        id,
        OR: [
          { deliveryLeaseToken: null },
          { deliveryLeaseUntil: null },
          { deliveryLeaseUntil: { lte: new Date() } },
        ],
      },
      data: {
        deliveryStatus: action === 'retry' ? 'pending' : action === 'pause' ? 'paused' : 'dismissed',
        deliveryLeaseToken: null,
        deliveryLeaseUntil: null,
        lastDeliveryErrorCode: null,
      },
    };
    const updated =
      kind === 'feedback'
        ? await tx.feedback.updateMany(change)
        : await tx.feedbackReply.updateMany(change);
    if (!updated.count) return 'busy';
    const feedbackId =
      kind === 'feedback'
        ? id
        : (await tx.feedbackReply.findUniqueOrThrow({ where: { id } })).feedbackId;
    await tx.feedbackEvent.create({
      data: {
        feedbackId,
        actorId: BigInt(actor),
        sourceUpdateId: updateId,
        action: `${kind}_${action}`,
      },
    });
    return 'saved';
  });
}
