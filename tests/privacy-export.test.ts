import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db/client.ts';
import {
  decodeExportCursor,
  encodeExportCursor,
  exportFeedbackWhere,
  EXPORT_PAGE_SIZE,
  getPersonalDataExportPage,
} from '../src/privacy/export.ts';

const createdAt = new Date('2026-10-12T20:00:00.000Z');

describe('personal data export cursor', () => {
  it('round-trips stable ordering fields', () => {
    const cursor = { createdAt, id: 'cuid_123' };
    expect(decodeExportCursor(encodeExportCursor(cursor))).toEqual(cursor);
    expect(decodeExportCursor('')).toBeUndefined();
    expect(exportFeedbackWhere('account')).toEqual({ userId: 'account' });
    const filter = exportFeedbackWhere('account', cursor);
    expect(filter.userId).toBe('account');
    expect(filter.OR).toHaveLength(2);
  });

  it('rejects malformed or forged pagination data before hitting PostgreSQL', () => {
    for (const raw of [
      '%%%bad',
      'A'.repeat(260),
      Buffer.from(JSON.stringify({ v: 2, t: createdAt.toISOString(), id: 'one' })).toString('base64url'),
      Buffer.from(JSON.stringify({ v: 1, t: 'not-a-time', id: 'one' })).toString('base64url'),
      Buffer.from(JSON.stringify({ v: 1, t: createdAt.toISOString(), id: '../../admin' })).toString(
        'base64url',
      ),
    ]) {
      expect(() => decodeExportCursor(raw)).toThrow('Invalid export cursor');
    }
  });
});

describe('bounded privacy export', () => {
  const user = {
    id: 'db-internal-id',
    telegramId: 123456789n,
    username: 'user',
    firstName: 'Test',
    language: 'en',
    createdAt,
    updatedAt: createdAt,
    lastSeenAt: createdAt,
  };
  it('limits query and document to one page and preserves a safe continuation cursor', async () => {
    const rows = Array.from({ length: EXPORT_PAGE_SIZE + 1 }, (_, i) => ({
      id: `fb${String(i).padStart(3, '0')}`,
      text: `Feedback ${i}`,
      createdAt,
      notifiedAt: null,
    }));
    const findUnique = vi.fn(async () => user);
    const findMany = vi.fn(
      async (...args: [{ where: { userId: string }; take: number; orderBy: unknown[] }]) => {
        void args;
        return rows;
      },
    );
    const db = { telegramUser: { findUnique }, feedback: { findMany } } as unknown as Database;
    const page = await getPersonalDataExportPage(db, 123456789);
    expect(page?.count).toBe(EXPORT_PAGE_SIZE);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'db-internal-id' },
        take: EXPORT_PAGE_SIZE + 1,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
    const decoded = JSON.parse(page!.fileContents.toString('utf8'));
    expect(decoded.user.telegramId).toBe('123456789');
    expect(decoded.user).not.toHaveProperty('id');
    expect(decoded.feedback).toHaveLength(EXPORT_PAGE_SIZE);
    expect(decoded.pagination.hasMore).toBe(true);
    expect(decodeExportCursor(page?.nextCursor ?? undefined)?.id).toBe('fb049');
    await getPersonalDataExportPage(db, 123456789, decodeExportCursor(page?.nextCursor ?? undefined));
    expect(findMany.mock.calls[1]?.[0]?.where.userId).toBe('db-internal-id');
  });

  it('returns null when the user was already erased', async () => {
    const findMany = vi.fn();
    const db = {
      telegramUser: { findUnique: vi.fn(async () => null) },
      feedback: { findMany },
    } as unknown as Database;
    expect(await getPersonalDataExportPage(db, 1)).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });
});
