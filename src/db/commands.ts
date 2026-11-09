import type { Database } from './client.ts';
import type { Prisma } from '../generated/prisma/client.ts';

type Transaction = Prisma.TransactionClient;
export const RECEIPT_RETENTION_MS = 7 * 86_400_000;

/** Serialized database mutations only: never hold this transaction across Telegram calls. */
export async function userMutation<T>(
  db: Database,
  telegramId: number,
  mutation: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(${BigInt(telegramId)})`;
    return mutation(tx);
  });
}

/** Receipt and state change commit together. Receipts contain no user IDs or message text. */
export async function commandOnce(
  db: Database,
  telegramId: number,
  updateId: number,
  mutation: (tx: Transaction) => Promise<string>,
): Promise<string> {
  return userMutation(db, telegramId, async (tx) => {
    const existing = await tx.commandReceipt.findUnique({ where: { updateId } });
    if (existing) return String(existing.result);
    const user = await tx.telegramUser.findUnique({ where: { telegramId: BigInt(telegramId) } });
    // Telegram chooses a new random sequence after a week without updates.
    const stale =
      user?.lastStateUpdateAt &&
      Date.now() - user.lastStateUpdateAt.getTime() < RECEIPT_RETENTION_MS &&
      user.lastStateUpdateId !== null &&
      user.lastStateUpdateId > updateId;
    const result = stale ? 'stale' : await mutation(tx);
    if (!stale && user) {
      await tx.telegramUser.updateMany({
        where: { id: user.id },
        data: { lastStateUpdateId: updateId, lastStateUpdateAt: new Date() },
      });
    }
    await tx.commandReceipt.create({ data: { updateId, result } });
    return result;
  });
}
