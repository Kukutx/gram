/** Shared, dependency-free thresholds for operator diagnostics. */
export type OutboxHealth = 'empty' | 'pending' | 'warning' | 'critical' | 'unknown';
export const OUTBOX_WARNING_AGE_MS = 10 * 60_000;
export const OUTBOX_CRITICAL_AGE_MS = 60 * 60_000;

export function classifyOutboxHealth(
  pending: number,
  oldestCreatedAt: Date | null,
  now: Date = new Date(),
): {
  status: OutboxHealth;
  oldestPendingAgeSeconds: number | null;
} {
  if (!Number.isSafeInteger(pending) || pending < 0) throw new RangeError('Invalid pending count');
  if (pending === 0) return { status: 'empty', oldestPendingAgeSeconds: null };
  if (!oldestCreatedAt || !Number.isFinite(oldestCreatedAt.getTime())) {
    return { status: 'unknown', oldestPendingAgeSeconds: null };
  }
  const ageMs = Math.max(0, now.getTime() - oldestCreatedAt.getTime());
  const status: OutboxHealth =
    ageMs >= OUTBOX_CRITICAL_AGE_MS
      ? 'critical'
      : ageMs >= OUTBOX_WARNING_AGE_MS
        ? 'warning'
        : 'pending';
  return { status, oldestPendingAgeSeconds: Math.floor(ageMs / 1_000) };
}
