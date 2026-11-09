import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db/client.ts';
import {
  feedbackRetentionCutoff,
  purgeExpiredFeedback,
  RETENTION_BATCH_SIZE,
} from '../src/maintenance/retention.ts';

describe('opt-in data retention', () => {
  const now = new Date('2026-10-12T00:00:00Z');
  it('defaults to no deletion and validates durations', () => {
    expect(feedbackRetentionCutoff(0, now)).toBeUndefined();
    expect(feedbackRetentionCutoff(30, now)).toEqual(new Date('2026-09-12T00:00:00Z'));
    expect(() => feedbackRetentionCutoff(-1, now)).toThrow();
    expect(() => feedbackRetentionCutoff(3651, now)).toThrow();
  });
  it('does not touch the database when retention is disabled', async () => {
    const findMany = vi.fn();
    const count = await purgeExpiredFeedback({ feedback: { findMany } } as unknown as Database, 0, now);
    expect(count).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
  it('deletes only selected expired IDs, in bounded batches', async () => {
    const findMany = vi.fn(async () => [{ id: 'one' }, { id: 'two' }]);
    const deleteMany = vi.fn(async () => ({ count: 2 }));
    const db = { feedback: { findMany, deleteMany } } as unknown as Database;
    expect(await purgeExpiredFeedback(db, 30, now)).toBe(2);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: RETENTION_BATCH_SIZE }));
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['one', 'two'] }, createdAt: { lt: new Date('2026-09-12T00:00:00Z') } },
    });
  });
});
