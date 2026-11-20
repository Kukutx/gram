import type { Database } from './client.ts';

/**
 * Claiming in PostgreSQL closes the window in which different queue jobs or
 * worker instances might send the same pending notification simultaneously.
 * It cannot make an external Telegram API send exactly once after a crash.
 *
 * Feedback rows (admin notices) and reply rows (user notices) share the same
 * delivery columns, so one implementation serves both outboxes.
 */
export const DELIVERY_LEASE_MS = 5 * 60_000;
/** Durable cooldown after a temporary failure; also applies without Redis. */
export const DELIVERY_RETRY_COOLDOWN_MS = 60_000;

export type OutboxKind = 'feedback' | 'reply';

type DeliveryUpdate = {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
};

function updateMany(db: Database, kind: OutboxKind, args: DeliveryUpdate): Promise<{ count: number }> {
  // Both models expose identical delivery columns; Prisma's per-model types differ only nominally.
  return kind === 'feedback'
    ? db.feedback.updateMany(args as Parameters<Database['feedback']['updateMany']>[0])
    : db.feedbackReply.updateMany(args as Parameters<Database['feedbackReply']['updateMany']>[0]);
}

export async function claimDelivery(
  db: Database,
  kind: OutboxKind,
  id: string,
  token: string,
  now: Date = new Date(),
): Promise<boolean> {
  const updated = await updateMany(db, kind, {
    where: {
      id,
      notifiedAt: null,
      deliveryStatus: 'pending',
      OR: [{ deliveryLeaseUntil: null }, { deliveryLeaseUntil: { lte: now } }],
    },
    data: {
      deliveryLeaseToken: token,
      deliveryLeaseUntil: new Date(now.getTime() + DELIVERY_LEASE_MS),
      deliveryAttempts: { increment: 1 },
    },
  });
  return updated.count === 1;
}

/** Only the current lease holder can confirm; a stolen/expired lease is a no-op. */
export async function markDelivered(
  db: Database,
  kind: OutboxKind,
  id: string,
  token: string,
  now: Date = new Date(),
): Promise<boolean> {
  const updated = await updateMany(db, kind, {
    where: { id, notifiedAt: null, deliveryLeaseToken: token },
    data: {
      notifiedAt: now,
      deliveryStatus: 'sent',
      deliveryLeaseToken: null,
      deliveryLeaseUntil: null,
      lastDeliveryErrorCode: null,
    },
  });
  return updated.count === 1;
}

/**
 * Records a failed attempt. Permanent errors park the row as `blocked` for an
 * operator; temporary ones keep it `pending` with a cooldown stored as the lease.
 */
export async function markDeliveryFailed(
  db: Database,
  kind: OutboxKind,
  id: string,
  token: string,
  failure: { code: number | null; permanent: boolean },
  now: Date = new Date(),
): Promise<void> {
  await updateMany(db, kind, {
    where: { id, deliveryLeaseToken: token },
    data: {
      deliveryStatus: failure.permanent ? 'blocked' : 'pending',
      lastDeliveryErrorCode: failure.code,
      lastDeliveryErrorAt: now,
      deliveryLeaseToken: null,
      deliveryLeaseUntil: failure.permanent
        ? null
        : new Date(now.getTime() + DELIVERY_RETRY_COOLDOWN_MS),
    },
  });
}

export async function releaseDelivery(
  db: Database,
  kind: OutboxKind,
  id: string,
  token: string,
): Promise<void> {
  // The lease must not be released by a worker with an old/stolen token.
  await updateMany(db, kind, {
    where: { id, notifiedAt: null, deliveryLeaseToken: token },
    data: { deliveryLeaseToken: null, deliveryLeaseUntil: null },
  });
}

// Feedback-specific aliases kept for callers and tests written against v1.5.
export const claimFeedbackDelivery = (db: Database, id: string, token: string, now?: Date) =>
  claimDelivery(db, 'feedback', id, token, now);
export const markFeedbackDelivered = (db: Database, id: string, token: string) =>
  markDelivered(db, 'feedback', id, token);
export const releaseFeedbackDelivery = (db: Database, id: string, token: string) =>
  releaseDelivery(db, 'feedback', id, token);
