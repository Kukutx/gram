import { describe, expect, it } from 'vitest';
import {
  decideRecoveryAction,
  recoveryRetryDelayMs,
  RECOVERY_RETRY_MAX_MS,
} from '../src/queue/reconciliation.ts';

const now = Date.parse('2026-10-12T10:00:00.000Z');

describe('durable feedback outbox reconciliation', () => {
  it('enqueues missing jobs but never duplicates active, waiting, or delayed jobs', () => {
    expect(decideRecoveryAction(undefined, undefined, 0, now)).toBe('enqueue');
    expect(decideRecoveryAction('unknown', undefined, 0, now)).toBe('enqueue');
    for (const state of ['active', 'waiting', 'delayed', 'prioritized', 'waiting-children']) {
      expect(decideRecoveryAction(state, undefined, 0, now)).toBe('skip');
    }
  });

  it('recovers a DB-unnotified completed job only after a cool-off period', () => {
    expect(decideRecoveryAction('completed', now - 59_999, 1, now)).toBe('skip');
    expect(decideRecoveryAction('completed', now - 60_001, 1, now)).toBe('replace');
    expect(decideRecoveryAction('completed', undefined, 1, now)).toBe('skip');
  });

  it('retries exhausted failures after bounded exponential delays', () => {
    const delay = recoveryRetryDelayMs(6);
    expect(delay).toBe(5 * 60_000 * 2 ** 5);
    expect(decideRecoveryAction('failed', now - delay + 1, 6, now)).toBe('skip');
    expect(decideRecoveryAction('failed', now - delay, 6, now)).toBe('retry');
    expect(recoveryRetryDelayMs(1000)).toBe(RECOVERY_RETRY_MAX_MS);
  });

  it('never fast-loops on malformed failures', () => {
    expect(decideRecoveryAction('failed', undefined, 5, now)).toBe('skip');
    expect(decideRecoveryAction('failed', Number.NaN, 5, now)).toBe('skip');
  });
});
