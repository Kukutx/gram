import { describe, expect, it } from 'vitest';
import { nextOutboxCursor, outboxWhere } from '../src/queue/outbox.ts';

describe('keyset pagination', () => {
  it('starts without a cursor and resumes by (createdAt, id), even if the cursor row is deleted', () => {
    expect(outboxWhere(undefined)).toEqual({ notifiedAt: null, deliveryStatus: 'pending' });
    const now = new Date('2026-10-12T11:00:00Z');
    const cursor = { createdAt: now, id: 'feedback_a' };
    expect(nextOutboxCursor([cursor])).toBe(cursor);
    expect(nextOutboxCursor([])).toBeUndefined();
    expect(outboxWhere(cursor)).toEqual({
      notifiedAt: null,
      deliveryStatus: 'pending',
      OR: [{ createdAt: { gt: now } }, { createdAt: now, id: { gt: 'feedback_a' } }],
    });
  });
});
