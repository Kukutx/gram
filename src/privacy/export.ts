/** Bounded, resumable personal-data export; no external storage or extra copies. */
import type { Database } from '../db/client.ts';

export const EXPORT_PAGE_SIZE = 100;
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

/** Keyset condition for newest-first pages: strictly older than the cursor. */
export function beforeCursor(cursor?: ExportCursor) {
  return cursor
    ? {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      }
    : {};
}

/**
 * One page of the user's data: profile and ticket list on every page (both small),
 * plus up to EXPORT_PAGE_SIZE messages in both directions, newest first.
 */
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
  const [tickets, rows] = await Promise.all([
    db.ticket.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 1_000,
      select: { number: true, status: true, createdAt: true, resolvedAt: true, lastMessageAt: true },
    }),
    db.ticketMessage.findMany({
      where: { ticket: { userId: user.id }, ...beforeCursor(cursor) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: EXPORT_PAGE_SIZE + 1,
      select: {
        id: true,
        direction: true,
        text: true,
        attachmentType: true,
        createdAt: true,
        ticket: { select: { number: true } },
        deliveries: { where: { chatId: user.telegramId }, select: { status: true, sentAt: true } },
      },
    }),
  ]);
  const messages = rows.slice(0, EXPORT_PAGE_SIZE);
  const last = messages.at(-1);
  const nextCursor = rows.length > EXPORT_PAGE_SIZE && last ? encodeExportCursor(last) : null;
  const payload = {
    schemaVersion: 3,
    exportedAt: new Date().toISOString(),
    pagination: { count: messages.length, hasMore: nextCursor !== null, nextCursor },
    user: {
      telegramId: String(user.telegramId),
      username: user.username,
      firstName: user.firstName,
      language: user.language,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastSeenAt: user.lastSeenAt,
    },
    tickets,
    messages: messages.map((m) => ({
      id: m.id,
      ticket: m.ticket.number,
      direction: m.direction,
      text: m.text,
      attachmentType: m.attachmentType,
      createdAt: m.createdAt,
      deliveredToYou: m.direction === 'outbound' ? (m.deliveries[0]?.sentAt ?? null) : undefined,
    })),
  };
  return {
    fileContents: Buffer.from(JSON.stringify(payload, null, 2), 'utf8'),
    nextCursor,
    count: messages.length,
  };
}
