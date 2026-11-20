import type { User as TelegramFrom } from 'grammy/types';
import type { Database } from './client.ts';
import { expiresInFifteenMinutes } from '../domain/feedback.ts';
import { normalizeLanguage, type Language } from '../domain/i18n.ts';
import { commandOnce, userMutation, type Transaction } from './commands.ts';
import { LAST_SEEN_REFRESH_MS, RECEIPT_RETENTION_MS } from '../config/constants.ts';

const USER_SNAPSHOT = {
  id: true,
  telegramId: true,
  username: true,
  firstName: true,
  language: true,
  awaitingFeedback: true,
  feedbackExpiresAt: true,
  lastSeenAt: true,
} as const;

export type UserSnapshot = {
  id: string;
  telegramId: bigint;
  username: string | null;
  firstName: string | null;
  language: string;
  awaitingFeedback: boolean;
  feedbackExpiresAt: Date | null;
  lastSeenAt: Date;
};

/**
 * Loads (and creates on first contact) the minimum profile needed per update.
 * Unchanged profiles are written at most every LAST_SEEN_REFRESH_MS, so the
 * common path is a single indexed read instead of an upsert per update.
 */
export async function touchUser(
  db: Database,
  from: TelegramFrom,
  now: Date = new Date(),
): Promise<UserSnapshot> {
  const telegramId = BigInt(from.id);
  const username = from.username ?? null;
  const firstName = from.first_name ?? null;
  const existing = await db.telegramUser.findUnique({ where: { telegramId }, select: USER_SNAPSHOT });
  if (
    existing &&
    existing.username === username &&
    existing.firstName === firstName &&
    now.getTime() - existing.lastSeenAt.getTime() < LAST_SEEN_REFRESH_MS
  )
    return existing;
  return db.telegramUser.upsert({
    where: { telegramId },
    create: { telegramId, username, firstName, language: normalizeLanguage(from.language_code) },
    update: { username, firstName, lastSeenAt: now },
    select: USER_SNAPSHOT,
  });
}

export async function getLanguage(db: Database, telegramId: number): Promise<Language> {
  const user = await db.telegramUser.findUnique({
    where: { telegramId: BigInt(telegramId) },
    select: { language: true },
  });
  return normalizeLanguage(user?.language);
}

export async function setLanguage(
  db: Database,
  telegramId: number,
  language: Language,
  updateId?: number,
): Promise<void> {
  const mutate = async (tx: Database | Transaction) => {
    await tx.telegramUser.update({ where: { telegramId: BigInt(telegramId) }, data: { language } });
    return 'saved';
  };
  if (updateId !== undefined) await commandOnce(db, telegramId, updateId, mutate);
  else await mutate(db);
}

export async function beginFeedback(db: Database, telegramId: number, updateId?: number): Promise<void> {
  const mutate = async (tx: Database | Transaction) => {
    await tx.telegramUser.update({
      where: { telegramId: BigInt(telegramId) },
      data: { awaitingFeedback: true, feedbackExpiresAt: expiresInFifteenMinutes() },
    });
    return 'started';
  };
  if (updateId !== undefined) await commandOnce(db, telegramId, updateId, mutate);
  else await mutate(db);
}

export async function cancelFeedback(
  db: Database,
  telegramId: number,
  updateId?: number,
): Promise<boolean> {
  const mutate = async (tx: Database | Transaction) => {
    const updated = await tx.telegramUser.updateMany({
      where: { telegramId: BigInt(telegramId), awaitingFeedback: true },
      data: { awaitingFeedback: false, feedbackExpiresAt: null },
    });
    return updated.count > 0 ? 'canceled' : 'none';
  };
  return (
    (updateId !== undefined ? await commandOnce(db, telegramId, updateId, mutate) : await mutate(db)) ===
    'canceled'
  );
}

/** Clear only a truly expired state; do not erase a new /feedback from a concurrent update. */
export async function expireFeedback(db: Database, telegramId: number): Promise<boolean> {
  const result = await db.telegramUser.updateMany({
    where: {
      telegramId: BigInt(telegramId),
      awaitingFeedback: true,
      feedbackExpiresAt: { lte: new Date() },
    },
    data: { awaitingFeedback: false, feedbackExpiresAt: null },
  });
  return result.count > 0;
}

export async function getFeedbackState(
  db: Database,
  telegramId: number,
): Promise<'none' | 'active' | 'expired'> {
  const state = await db.telegramUser.findUnique({
    where: { telegramId: BigInt(telegramId) },
    select: { awaitingFeedback: true, feedbackExpiresAt: true },
  });
  if (!state?.awaitingFeedback) return 'none';
  return state.feedbackExpiresAt && state.feedbackExpiresAt > new Date() ? 'active' : 'expired';
}

/** Atomic state consumption + unique update ID: safe against duplicate webhook deliveries. */
export async function consumeFeedback(
  db: Database,
  telegramId: number,
  sourceUpdateId: number,
  text: string,
): Promise<{ id: string } | null> {
  return userMutation(db, telegramId, async (tx) => {
    const existing = await tx.feedback.findUnique({ where: { sourceUpdateId }, select: { id: true } });
    if (existing) return existing; // A retry may need to requeue this same feedback.

    const userState = await tx.telegramUser.findUnique({ where: { telegramId: BigInt(telegramId) } });
    if (
      userState?.lastStateUpdateId !== null &&
      userState?.lastStateUpdateId !== undefined &&
      userState.lastStateUpdateId > sourceUpdateId &&
      userState.lastStateUpdateAt &&
      Date.now() - userState.lastStateUpdateAt.getTime() < RECEIPT_RETENTION_MS
    )
      return null;

    const claimed = await tx.telegramUser.updateMany({
      where: {
        telegramId: BigInt(telegramId),
        awaitingFeedback: true,
        feedbackExpiresAt: { gt: new Date() },
      },
      data: {
        awaitingFeedback: false,
        feedbackExpiresAt: null,
        lastStateUpdateId: sourceUpdateId,
        lastStateUpdateAt: new Date(),
      },
    });
    if (claimed.count === 0) return null;

    const user = await tx.telegramUser.findUniqueOrThrow({
      where: { telegramId: BigInt(telegramId) },
      select: { id: true },
    });
    return tx.feedback.create({
      data: { userId: user.id, sourceUpdateId, text },
      select: { id: true },
    });
  });
}

export async function deleteMyData(db: Database, telegramId: number): Promise<void> {
  await db.telegramUser.deleteMany({ where: { telegramId: BigInt(telegramId) } });
  // Database cascade deletes related feedback. Pending notification jobs contain IDs only.
}

export async function countStats(db: Database) {
  const [users, feedback, pending] = await Promise.all([
    db.telegramUser.count(),
    db.feedback.count(),
    db.feedback.count({ where: { notifiedAt: null, deliveryStatus: 'pending' } }),
  ]);
  return { users, feedback, pending };
}

export async function listFeedback(db: Database, limit = 5) {
  return db.feedback.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { user: { select: { telegramId: true, username: true } } },
  });
}

/** Personal data inventory for the authenticated Telegram user only. */
export async function getMyDataSummary(db: Database, telegramId: number) {
  const user = await db.telegramUser.findUnique({
    where: { telegramId: BigInt(telegramId) },
    select: {
      telegramId: true,
      language: true,
      createdAt: true,
      lastSeenAt: true,
      _count: { select: { feedback: true } },
    },
  });
  return user;
}
