import type { Database } from './client.ts';

/**
 * Claiming in PostgreSQL closes the window in which different queue jobs or
 * worker instances might send the same pending feedback simultaneously.
 * It cannot make an external Telegram API send exactly once after a crash.
 */
export const DELIVERY_LEASE_MS = 5 * 60_000;

export async function claimFeedbackDelivery(
  db: Database,
  feedbackId: string,
  token: string,
  now: Date = new Date(),
): Promise<boolean> {
  const updated = await db.feedback.updateMany({
    where: {
      id: feedbackId,
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

export async function markFeedbackDelivered(
  db: Database,
  feedbackId: string,
  token: string,
): Promise<boolean> {
  const updated = await db.feedback.updateMany({
    where: { id: feedbackId, notifiedAt: null, deliveryLeaseToken: token },
    data: {
      notifiedAt: new Date(),
      deliveryStatus: 'sent',
      deliveryLeaseToken: null,
      deliveryLeaseUntil: null,
      lastDeliveryErrorCode: null,
    },
  });
  return updated.count === 1;
}

export async function releaseFeedbackDelivery(
  db: Database,
  feedbackId: string,
  token: string,
): Promise<void> {
  // The lease must not be released by a worker with an old/stolen token.
  await db.feedback.updateMany({
    where: { id: feedbackId, notifiedAt: null, deliveryLeaseToken: token },
    data: { deliveryLeaseToken: null, deliveryLeaseUntil: null },
  });
}
