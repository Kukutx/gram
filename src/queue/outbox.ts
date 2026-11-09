export type OutboxCursor = { createdAt: Date; id: string };

/**
 * Stable keyset query for unnotified records. Unlike Prisma cursor=id, it
 * continues working when the previously scanned row is deleted concurrently.
 */
export function outboxWhere(cursor: OutboxCursor | undefined) {
  return cursor
    ? {
        notifiedAt: null,
        deliveryStatus: 'pending',
        OR: [
          { createdAt: { gt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { gt: cursor.id } },
        ],
      }
    : { notifiedAt: null, deliveryStatus: 'pending' };
}

/** Postgres sorts by timestamp then ID, matching the index and cursor. */
export function nextOutboxCursor(rows: readonly OutboxCursor[]): OutboxCursor | undefined {
  return rows.length > 0 ? rows[rows.length - 1] : undefined;
}
