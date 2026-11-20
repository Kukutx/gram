import type { Database } from '../db/client.ts';
import { hasSupportTeam, type AppConfig } from '../config/env.ts';
import { DAY_MS, HEARTBEAT_FRESH_MS } from '../config/constants.ts';
import { Prisma } from '../generated/prisma/client.ts';
import { classifyOutboxHealth } from './outbox-health.ts';

export type HeartbeatKind = 'worker' | 'dispatch' | 'retention';

export async function heartbeat(db: Database, id: string, kind: HeartbeatKind): Promise<void> {
  await db.runtimeHeartbeat.upsert({
    where: { id },
    create: { id, kind },
    update: { lastSeenAt: new Date() },
  });
}

type Row = {
  pending: bigint;
  blocked: bigint;
  oldest_pending: Date | null;
  oldest_activity: Date | null;
  worker: Date | null;
  dispatch: Date | null;
  retention: Date | null;
};

/**
 * One round trip for every operational signal: outbox backlog, parked deliveries,
 * heartbeats (scoped to the current RELEASE_ID when set) and retention lag.
 */
export async function operationsHealth(db: Database, config: AppConfig, now = new Date()) {
  const release = (kind: HeartbeatKind) =>
    config.RELEASE_ID ? `${kind}:${config.RELEASE_ID}:%` : `${kind}:%`;
  const [row] = await db.$queryRaw<Row[]>(Prisma.sql`
    SELECT
      (SELECT count(*) FROM "Delivery" WHERE "status" = 'pending') AS pending,
      (SELECT count(*) FROM "Delivery" WHERE "status" = 'blocked') AS blocked,
      (SELECT min("createdAt") FROM "Delivery" WHERE "status" = 'pending') AS oldest_pending,
      (SELECT min("lastMessageAt") FROM "Ticket") AS oldest_activity,
      (SELECT max("lastSeenAt") FROM "RuntimeHeartbeat" WHERE "kind" = 'worker' AND "id" LIKE ${release('worker')}) AS worker,
      (SELECT max("lastSeenAt") FROM "RuntimeHeartbeat" WHERE "kind" = 'dispatch' AND "id" LIKE ${release('dispatch')}) AS dispatch,
      (SELECT max("lastSeenAt") FROM "RuntimeHeartbeat" WHERE "kind" = 'retention' AND "id" LIKE ${release('retention')}) AS retention`);
  const r = row!;
  const fresh = (date: Date | null) =>
    date !== null && now.getTime() - date.getTime() < HEARTBEAT_FRESH_MS;
  const pending = Number(r.pending);
  const blocked = Number(r.blocked);
  const outbox = classifyOutboxHealth(pending, r.oldest_pending, now);
  const retentionDays = config.FEEDBACK_RETENTION_DAYS;
  const retentionOverdueSeconds =
    retentionDays > 0 && r.oldest_activity
      ? Math.max(
          0,
          Math.floor((now.getTime() - r.oldest_activity.getTime() - retentionDays * DAY_MS) / 1_000),
        )
      : 0;
  const deliveries = hasSupportTeam(config);
  return {
    healthy:
      fresh(r.worker) &&
      fresh(r.dispatch) &&
      blocked === 0 &&
      outbox.status !== 'critical' &&
      (retentionDays === 0 || (fresh(r.retention) && retentionOverdueSeconds < 300)),
    /** Receipts, retention and the outbox all need the worker, with or without admins. */
    workerRequired: true,
    notificationsConfigured: deliveries,
    workerFresh: fresh(r.worker),
    dispatchFresh: fresh(r.dispatch),
    retentionFresh: fresh(r.retention),
    pending,
    blocked,
    retentionOverdueSeconds,
    ...outbox,
  };
}

export type OperationsHealth = Awaited<ReturnType<typeof operationsHealth>>;
