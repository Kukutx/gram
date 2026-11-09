/** Bounded, resumable personal-data export; no additional bot framework or external storage. */
import type { Database } from '../db/client.ts';

export const EXPORT_PAGE_SIZE = 50;
export const EXPORT_CURSOR_LIMIT = 256;
export type ExportCursor = { createdAt: Date; id: string };

/** Opaque pagination cursor, not an authorization token. Ownership is ALWAYS enforced in SQL. */
export function encodeExportCursor(cursor: ExportCursor): string {
  return Buffer.from(
    JSON.stringify({ v: 1, t: cursor.createdAt.toISOString(), id: cursor.id }),
  ).toString('base64url');
}

export function decodeExportCursor(raw: string | undefined): ExportCursor | undefined {
  if (!raw || raw.trim() === '') return undefined;
  const token = raw.trim();
  if (token.length > EXPORT_CURSOR_LIMIT || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error('Invalid export cursor');
  }
  try {
    const decoded: unknown = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (!decoded || typeof decoded !== 'object') throw new Error('bad payload');
    const data = decoded as Record<string, unknown>;
    if (data.v !== 1 || typeof data.t !== 'string' || typeof data.id !== 'string')
      throw new Error('bad fields');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(data.id)) throw new Error('bad id');
    const date = new Date(data.t);
    if (Number.isNaN(date.getTime()) || date.toISOString() !== data.t) throw new Error('bad date');
    return { createdAt: date, id: data.id };
  } catch {
    throw new Error('Invalid export cursor');
  }
}

export function exportFeedbackWhere(userId: string, cursor?: ExportCursor) {
  return cursor
    ? {
        userId,
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      }
    : { userId };
}

export async function getPersonalDataExportPage(
  db: Database,
  telegramId: number,
  cursor?: ExportCursor,
) {
  const user = await db.telegramUser.findUnique({
    where: { telegramId: BigInt(telegramId) },
    select: {
      id: true,
      telegramId: true,
      username: true,
      firstName: true,
      language: true,
      createdAt: true,
      updatedAt: true,
      lastSeenAt: true,
    },
  });
  if (!user) return null;
  const result = await db.feedback.findMany({
    where: exportFeedbackWhere(user.id, cursor),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: EXPORT_PAGE_SIZE + 1,
    select: { id: true, text: true, createdAt: true, notifiedAt: true, status: true, resolvedAt: true },
  });
  const feedback = result.slice(0, EXPORT_PAGE_SIZE);
  const last = feedback[feedback.length - 1];
  const nextCursor =
    result.length > EXPORT_PAGE_SIZE && last
      ? encodeExportCursor({ createdAt: last.createdAt, id: last.id })
      : null;
  const payload = {
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    pagination: { count: feedback.length, hasMore: nextCursor !== null, nextCursor },
    user: {
      telegramId: String(user.telegramId),
      username: user.username,
      firstName: user.firstName,
      language: user.language,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastSeenAt: user.lastSeenAt,
    },
    feedback,
  };
  return {
    fileContents: Buffer.from(JSON.stringify(payload, null, 2), 'utf8'),
    nextCursor,
    count: feedback.length,
  };
}

/** Replies have their own bounded cursor so a busy ticket cannot make an export unbounded. */
export async function getPersonalReplyExportPage(
  db: Database,
  telegramId: number,
  cursor?: ExportCursor,
) {
  const rows = await db.feedbackReply.findMany({
    where: {
      feedback: { user: { telegramId: BigInt(telegramId) } },
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: EXPORT_PAGE_SIZE + 1,
    select: {
      id: true,
      feedbackId: true,
      text: true,
      createdAt: true,
      notifiedAt: true,
      deliveryStatus: true,
    },
  });
  const replies = rows.slice(0, EXPORT_PAGE_SIZE);
  const last = replies.at(-1);
  const nextCursor = rows.length > EXPORT_PAGE_SIZE && last ? encodeExportCursor(last) : null;
  return {
    fileContents: Buffer.from(
      JSON.stringify(
        {
          schemaVersion: 2,
          exportedAt: new Date().toISOString(),
          replies,
          pagination: { count: replies.length, hasMore: nextCursor !== null, nextCursor },
        },
        null,
        2,
      ),
    ),
    nextCursor,
  };
}
