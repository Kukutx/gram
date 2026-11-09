import { describe, expect, it } from 'vitest';
import {
  classifyOutboxHealth,
  OUTBOX_WARNING_AGE_MS,
  OUTBOX_CRITICAL_AGE_MS,
} from '../src/observability/outbox-health.ts';

describe('operator outbox health thresholds', () => {
  const now = new Date('2026-10-13T00:00:00.000Z');
  it('recognizes no pending work', () => {
    expect(classifyOutboxHealth(0, null, now)).toEqual({
      status: 'empty',
      oldestPendingAgeSeconds: null,
    });
  });
  it('classifies backlogs by oldest pending age', () => {
    expect(classifyOutboxHealth(1, new Date(now.getTime() - 1_000), now).status).toBe('pending');
    expect(classifyOutboxHealth(1, new Date(now.getTime() - OUTBOX_WARNING_AGE_MS), now).status).toBe(
      'warning',
    );
    expect(classifyOutboxHealth(1, new Date(now.getTime() - OUTBOX_CRITICAL_AGE_MS), now).status).toBe(
      'critical',
    );
  });
  it('treats missing timestamps conservatively', () => {
    expect(classifyOutboxHealth(1, null, now).status).toBe('unknown');
    expect(classifyOutboxHealth(1, new Date(now.getTime() + 3000), now).oldestPendingAgeSeconds).toBe(0);
    expect(() => classifyOutboxHealth(-1, null, now)).toThrow(RangeError);
  });
});
