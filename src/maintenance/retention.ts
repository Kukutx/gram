import type { Database } from '../db/client.ts';

export const RETENTION_BATCH_SIZE = 500;

/** Zero disables deletion. Other values are a deliberate operator policy. */
export function feedbackRetentionCutoff(days: number, now: Date = new Date()): Date | undefined {
  if (!Number.isInteger(days) || days < 0 || days > 3650) throw new Error('Invalid retention days');
  return days === 0 ? undefined : new Date(now.getTime() - days * 86_400_000);
}

export async function purgeExpiredFeedback(
  db: Database,
  retentionDays: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = feedbackRetentionCutoff(retentionDays, now);
  if (!cutoff) return 0;
  const expired = await db.feedback.findMany({
    where: { createdAt: { lt: cutoff } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: RETENTION_BATCH_SIZE,
    select: { id: true },
  });
  if (!expired.length) return 0;
  // Intentionally deletes also pending feedback: a configured retention period
  // is a hard upper bound. Worker treats missing IDs as no-ops.
  const result = await db.feedback.deleteMany({
    where: { id: { in: expired.map((row) => row.id) }, createdAt: { lt: cutoff } },
  });
  return result.count;
}
