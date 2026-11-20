import type { Database } from '../db/client.ts';
import { DAY_MS, RECEIPT_RETENTION_MS } from '../config/constants.ts';

export const RETENTION_BATCH_SIZE = 500;

/** Zero disables deletion. Other values are a deliberate operator policy. */
export function feedbackRetentionCutoff(days: number, now: Date = new Date()): Date | undefined {
  if (!Number.isInteger(days) || days < 0 || days > 3650) throw new Error('Invalid retention days');
  return days === 0 ? undefined : new Date(now.getTime() - days * DAY_MS);
}

/**
 * Deletes one batch of tickets without activity since the cutoff (cascading to
 * messages, pending deliveries and events). Returns how many were deleted.
 */
export async function purgeExpiredTickets(
  db: Database,
  retentionDays: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = feedbackRetentionCutoff(retentionDays, now);
  if (!cutoff) return 0;
  const expired = await db.ticket.findMany({
    where: { lastMessageAt: { lt: cutoff } },
    orderBy: [{ lastMessageAt: 'asc' }, { id: 'asc' }],
    take: RETENTION_BATCH_SIZE,
    select: { id: true },
  });
  if (!expired.length) return 0;
  // Re-check the cutoff: a follow-up may have arrived between the two statements.
  const result = await db.ticket.deleteMany({
    where: { id: { in: expired.map((row) => row.id) }, lastMessageAt: { lt: cutoff } },
  });
  return result.count;
}

/** Replay receipts and stale heartbeats are only useful for a week. */
export async function purgeRuntimeMetadata(db: Database, now: Date = new Date()): Promise<void> {
  const old = new Date(now.getTime() - RECEIPT_RETENTION_MS);
  const receipts = await db.commandReceipt.findMany({
    where: { createdAt: { lt: old } },
    take: 1_000,
    select: { updateId: true },
  });
  if (receipts.length)
    await db.commandReceipt.deleteMany({
      where: { updateId: { in: receipts.map((row) => row.updateId) } },
    });
  await db.runtimeHeartbeat.deleteMany({ where: { lastSeenAt: { lt: old } } });
}
