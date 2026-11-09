/**
 * A signed challenge bound to one user, consumed or revoked in PostgreSQL.
 * No extra signing secret is required. Callback data stays below 64 bytes.
 */
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import type { Database } from '../db/client.ts';
import { commandOnce, userMutation } from '../db/commands.ts';

export const DELETE_CONFIRM_TTL_SECONDS = 5 * 60;
const ACTION = 'erase:v2';
const SIGNATURE_LENGTH = 22;

function signature(userId: number, expiresAtSeconds: number, botToken: string, nonce: string): string {
  return createHmac('sha256', botToken)
    .update(`grammy/delete-confirm/v2:${userId}:${expiresAtSeconds}:${nonce}`)
    .digest('base64url')
    .slice(0, SIGNATURE_LENGTH);
}

export function createDeleteConfirmation(userId: number, botToken: string, nowMs = Date.now()): string {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !botToken)
    throw new Error('Invalid confirmation identity');
  const expires = Math.floor(nowMs / 1_000) + DELETE_CONFIRM_TTL_SECONDS;
  const nonce = randomBytes(12).toString('base64url');
  const result = `${ACTION}:${expires.toString(36)}:${nonce}:${signature(userId, expires, botToken, nonce)}`;
  if (Buffer.byteLength(result, 'utf8') > 64) throw new Error('Callback data too long');
  return result;
}

/** Returns false on malformed, expired, future-dated, wrong-user or forged data. */
export function verifyDeleteConfirmation(
  callbackData: string,
  userId: number,
  botToken: string,
  nowMs = Date.now(),
): boolean {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !botToken) return false;
  const match = /^erase:v2:([0-9a-z]{1,10}):([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]{22})$/.exec(callbackData);
  if (!match?.[1] || !match[2] || !match[3]) return false;
  const expires = Number.parseInt(match[1], 36);
  if (!Number.isSafeInteger(expires)) return false;
  const now = Math.floor(nowMs / 1_000);
  if (expires < now || expires > now + DELETE_CONFIRM_TTL_SECONDS) return false;
  const expected = Buffer.from(signature(userId, expires, botToken, match[2]), 'ascii');
  const actual = Buffer.from(match[3], 'ascii');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function confirmationNonce(data: string): string {
  return data.split(':')[3] ?? '';
}

export async function issueDeleteConfirmation(
  db: Database,
  userId: number,
  updateId: number,
  token: string,
): Promise<string> {
  return commandOnce(db, userId, updateId, async (tx) => {
    const data = createDeleteConfirmation(userId, token);
    await tx.telegramUser.update({
      where: { telegramId: BigInt(userId) },
      data: {
        deleteNonce: confirmationNonce(data),
        deleteExpiresAt: new Date(Date.now() + DELETE_CONFIRM_TTL_SECONDS * 1_000),
      },
    });
    return data;
  });
}

export async function cancelDeleteConfirmation(
  db: Database,
  userId: number,
  nonce: string,
): Promise<void> {
  await userMutation(db, userId, async (tx) => {
    await tx.telegramUser.updateMany({
      where: { telegramId: BigInt(userId), deleteNonce: nonce },
      data: { deleteNonce: null, deleteExpiresAt: null },
    });
  });
}

/** Consume the challenge and erase in the same transaction. Never recreate users here. */
export async function consumeDeleteConfirmation(
  db: Database,
  userId: number,
  data: string,
  token: string,
): Promise<boolean> {
  if (!verifyDeleteConfirmation(data, userId, token)) return false;
  return userMutation(db, userId, async (tx) => {
    const deleted = await tx.telegramUser.deleteMany({
      where: {
        telegramId: BigInt(userId),
        deleteNonce: confirmationNonce(data),
        deleteExpiresAt: { gt: new Date() },
      },
    });
    return deleted.count === 1;
  });
}
