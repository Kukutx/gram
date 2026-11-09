/**
 * Decides how the outbox scanner repairs a BullMQ job for a feedback row
 * that PostgreSQL still considers unnotified.
 *
 * The database is authoritative. A completed Redis job is NOT proof that
 * the database notification marker was committed. Conversely, a terminally
 * failed job must not block the record forever.
 */
export type RecoveryAction = 'enqueue' | 'retry' | 'replace' | 'skip';

export const RECOVERY_RETRY_BASE_MS = 5 * 60_000;
export const RECOVERY_RETRY_MAX_MS = 24 * 60 * 60_000;

export function recoveryRetryDelayMs(attemptsMade: number): number {
  // Bound the exponent to avoid overflow for corrupt/very old job metadata.
  const exponent = Math.max(0, Math.min(12, Math.trunc(attemptsMade) - 1));
  return Math.min(RECOVERY_RETRY_BASE_MS * 2 ** exponent, RECOVERY_RETRY_MAX_MS);
}

export function decideRecoveryAction(
  state: string | undefined,
  finishedOn: number | undefined,
  attemptsMade: number,
  nowMs: number = Date.now(),
): RecoveryAction {
  if (!state || state === 'unknown') return 'enqueue';
  if (state === 'completed') {
    // The DB marker may have failed to commit after the job finished.
    return finishedOn !== undefined && nowMs >= finishedOn + 60_000 ? 'replace' : 'skip';
  }
  if (state === 'failed') {
    // Missing completion timestamps are treated conservatively to prevent
    // unexpected rapid retry loops. Such jobs still appear in monitoring.
    if (finishedOn === undefined || !Number.isFinite(finishedOn)) return 'skip';
    return nowMs >= finishedOn + recoveryRetryDelayMs(attemptsMade) ? 'retry' : 'skip';
  }
  // Waiting, active, delayed, paused, waiting-children, prioritized, ...
  return 'skip';
}
