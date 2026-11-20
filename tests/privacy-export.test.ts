import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db/client.ts';
import {
  decodeExportCursor,
  encodeExportCursor,
  beforeCursor,
  EXPORT_PAGE_SIZE,
  getPersonalDataExportPage,
} from '../src/privacy/export.ts';

const createdAt = new Date('2026-10-12T20:00:00.000Z');

describe('personal data export cursor', () => {
  it('round-trips stable ordering fields', () => {
    const cursor = { createdAt, id: 'cuid_123' };
    expect(decodeExportCursor(encodeExportCursor(cursor))).toEqual(cursor);
    expect(decodeExportCursor('')).toBeUndefined();
    expect(beforeCursor()).toEqual({});
    expect(beforeCursor(cursor).OR).toHaveLength(2);
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
  const fake = (rows: unknown[]) => {
    const messages = vi.fn(
      async (args: { where: Record<string, unknown>; take: number; orderBy: unknown[] }) => {
        void args;
        return rows;
      },
    );
    const tickets = vi.fn(async () => [
      { number: 1, status: 'open', createdAt, resolvedAt: null, lastMessageAt: createdAt },
    ]);
    const db = {
      telegramUser: { findUnique: vi.fn(async () => user) },
      ticket: { findMany: tickets },
      ticketMessage: { findMany: messages },
    } as unknown as Database;
    return { db, messages };
  };

  it('limits query and document to one page and preserves a safe continuation cursor', async () => {
    const rows = Array.from({ length: EXPORT_PAGE_SIZE + 1 }, (_, i) => ({
      id: `m${String(i).padStart(3, '0')}`,
      direction: i % 2 ? 'outbound' : 'inbound',
      text: `Message ${i}`,
      attachmentType: null,
      createdAt,
      ticket: { number: 1 },
      deliveries: [],
    }));
    const { db, messages } = fake(rows);
    const page = await getPersonalDataExportPage(db, 123456789);
    expect(page?.count).toBe(EXPORT_PAGE_SIZE);
    expect(messages).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ticket: { userId: 'db-internal-id' } },
        take: EXPORT_PAGE_SIZE + 1,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
    const decoded = JSON.parse(page!.fileContents.toString('utf8'));
    expect(decoded.schemaVersion).toBe(3);
    expect(decoded.user.telegramId).toBe('123456789');
    expect(decoded.user).not.toHaveProperty('id');
    expect(decoded.tickets).toHaveLength(1);
    expect(decoded.messages).toHaveLength(EXPORT_PAGE_SIZE);
    expect(decoded.pagination.hasMore).toBe(true);
    const cursor = decodeExportCursor(page?.nextCursor ?? undefined);
    expect(cursor?.id).toBe(`m${String(EXPORT_PAGE_SIZE - 1).padStart(3, '0')}`);
    await getPersonalDataExportPage(db, 123456789, cursor);
    const second = messages.mock.calls[1]?.[0];
    expect(second?.where.ticket).toEqual({ userId: 'db-internal-id' });
    expect(second?.where.OR).toHaveLength(2);
  });

  it('returns null when the user was already erased', async () => {
    const findMany = vi.fn();
    const db = {
      telegramUser: { findUnique: vi.fn(async () => null) },
      ticket: { findMany },
      ticketMessage: { findMany },
    } as unknown as Database;
    expect(await getPersonalDataExportPage(db, 1)).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });
});
