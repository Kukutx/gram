import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrisma, type Database } from '../src/db/client.ts';
import {
  beginFeedback,
  consumeFeedback,
  deleteMyData,
  expireFeedback,
  getFeedbackState,
  touchUser,
} from '../src/db/repository.ts';
import { parseConfig } from '../src/config/env.ts';
import { claimFeedbackDelivery, markFeedbackDelivered } from '../src/db/notification-lease.ts';
import { purgeExpiredFeedback } from '../src/maintenance/retention.ts';

// Set TEST_DATABASE_URL to a disposable, migrated PostgreSQL database to run this suite.
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
let db: Database;
const telegramId = 800_000_000 + Math.floor(Math.random() * 100_000_000);
const updateId = 100_000_000 + Math.floor(Math.random() * 100_000_000);

integration('database integration', () => {
  beforeAll(async () => {
    db = createPrisma(
      parseConfig({
        BOT_TOKEN: '123456789:AAAAAAAAAAAAAAA',
        DATABASE_URL: process.env.TEST_DATABASE_URL,
      }),
    );
    await db.$connect();
  });
  afterAll(async () => {
    await db.telegramUser.deleteMany({ where: { telegramId: BigInt(telegramId) } });
    await db.$disconnect();
  });
  it('does not let delayed expiration cleanup cancel a newly started feedback', async () => {
    await touchUser(db, { id: telegramId, is_bot: false, first_name: 'Test' });
    await db.telegramUser.update({
      where: { telegramId: BigInt(telegramId) },
      data: { awaitingFeedback: true, feedbackExpiresAt: new Date(Date.now() - 60_000) },
    });
    // A concurrent /feedback arrived before the delayed expiration cleanup.
    await beginFeedback(db, telegramId);
    expect(await expireFeedback(db, telegramId)).toBe(false);
    expect(await getFeedbackState(db, telegramId)).toBe('active');
  });

  it('persists users, atomically consumes state, deduplicates updates, and cascades deletion', async () => {
    await touchUser(db, { id: telegramId, is_bot: false, first_name: 'Test' });
    await beginFeedback(db, telegramId);
    const first = await consumeFeedback(db, telegramId, updateId, 'feedback');
    expect(first?.id).toBeTruthy();
    const replay = await consumeFeedback(db, telegramId, updateId, 'feedback');
    expect(replay?.id).toBe(first?.id);
    const claim1 = await claimFeedbackDelivery(db, first!.id, '00000000-0000-4000-8000-000000000001');
    const claim2 = await claimFeedbackDelivery(db, first!.id, '00000000-0000-4000-8000-000000000002');
    expect(claim1).toBe(true);
    expect(claim2).toBe(false);
    expect(await markFeedbackDelivered(db, first!.id, 'wrong-token')).toBe(false);
    expect(await markFeedbackDelivered(db, first!.id, '00000000-0000-4000-8000-000000000001')).toBe(
      true,
    );
    const second = await consumeFeedback(db, telegramId, updateId + 1, 'another message');
    expect(second).toBeNull();
    expect(await purgeExpiredFeedback(db, 3650)).toBe(0);
    await deleteMyData(db, telegramId);
    expect(await db.feedback.count({ where: { sourceUpdateId: updateId } })).toBe(0);
  });
});
