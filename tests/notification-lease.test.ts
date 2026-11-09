import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db/client.ts';
import {
  claimFeedbackDelivery,
  DELIVERY_LEASE_MS,
  markFeedbackDelivered,
  releaseFeedbackDelivery,
} from '../src/db/notification-lease.ts';

describe('durable notification lease', () => {
  const now = new Date('2026-10-12T00:00:00Z');
  it('atomically claims undelivered unlocked rows with a bounded lease', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const db = { feedback: { updateMany } } as unknown as Database;
    expect(await claimFeedbackDelivery(db, 'f', 'token-1', now)).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'f',
        notifiedAt: null,
        deliveryStatus: 'pending',
        OR: [{ deliveryLeaseUntil: null }, { deliveryLeaseUntil: { lte: now } }],
      },
      data: {
        deliveryLeaseToken: 'token-1',
        deliveryLeaseUntil: new Date(now.getTime() + DELIVERY_LEASE_MS),
        deliveryAttempts: { increment: 1 },
      },
    });
  });
  it('does not send when another worker holds the lease', async () => {
    const db = { feedback: { updateMany: vi.fn(async () => ({ count: 0 })) } } as unknown as Database;
    expect(await claimFeedbackDelivery(db, 'f', 'token-2', now)).toBe(false);
  });
  it('confirms or releases only matching owner tokens', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const db = { feedback: { updateMany } } as unknown as Database;
    expect(await markFeedbackDelivered(db, 'f', 'owner')).toBe(true);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'f', notifiedAt: null, deliveryLeaseToken: 'owner' },
      }),
    );
    await releaseFeedbackDelivery(db, 'f', 'owner');
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { id: 'f', notifiedAt: null, deliveryLeaseToken: 'owner' },
      data: { deliveryLeaseToken: null, deliveryLeaseUntil: null },
    });
  });
});
