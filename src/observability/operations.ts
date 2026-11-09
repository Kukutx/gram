import type { Database } from '../db/client.ts';
import type { AppConfig } from '../config/env.ts';
import { classifyOutboxHealth } from './outbox-health.ts';

export async function heartbeat(db: Database, id: string, kind: string): Promise<void> {
  await db.runtimeHeartbeat.upsert({
    where: { id },
    create: { id, kind },
    update: { lastSeenAt: new Date() },
  });
}

export async function operationsHealth(db: Database, config: AppConfig, now = new Date()) {
  const pendingWhere = { notifiedAt: null, deliveryStatus: 'pending' };
  const heartbeatWhere = (kind: string) => ({
    kind,
    ...(config.RELEASE_ID ? { id: { startsWith: `${kind}:${config.RELEASE_ID}:` } } : {}),
  });
  const [
    worker,
    dispatch,
    retention,
    pending,
    replies,
    blocked,
    blockedReplies,
    oldest,
    oldestReply,
    expired,
  ] = await Promise.all([
    db.runtimeHeartbeat.findFirst({ where: heartbeatWhere('worker'), orderBy: { lastSeenAt: 'desc' } }),
    db.runtimeHeartbeat.findFirst({
      where: heartbeatWhere('dispatch'),
      orderBy: { lastSeenAt: 'desc' },
    }),
    db.runtimeHeartbeat.findFirst({
      where: heartbeatWhere('retention'),
      orderBy: { lastSeenAt: 'desc' },
    }),
    db.feedback.count({ where: pendingWhere }),
    db.feedbackReply.count({ where: pendingWhere }),
    db.feedback.count({ where: { deliveryStatus: 'blocked' } }),
    db.feedbackReply.count({ where: { deliveryStatus: 'blocked' } }),
    db.feedback.findFirst({
      where: pendingWhere,
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
    db.feedbackReply.findFirst({
      where: pendingWhere,
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
    config.FEEDBACK_RETENTION_DAYS > 0
      ? db.feedback.findFirst({
          where: {
            createdAt: { lt: new Date(now.getTime() - config.FEEDBACK_RETENTION_DAYS * 86_400_000) },
          },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        })
      : null,
  ]);
  const fresh = (date?: Date) => date !== undefined && now.getTime() - date.getTime() < 120_000;
  const notificationEnabled = Boolean(config.ADMIN_TELEGRAM_ID);
  // Command receipt expiry requires maintenance even when notifications and retention are disabled.
  const maintenanceRequired = true;
  const oldestAt =
    [oldest?.createdAt, oldestReply?.createdAt]
      .filter((d): d is Date => Boolean(d))
      .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  const outbox = classifyOutboxHealth(pending + replies, oldestAt, now);
  const overdueSeconds = expired
    ? Math.max(
        0,
        Math.floor(
          (now.getTime() - expired.createdAt.getTime()) / 1000 - config.FEEDBACK_RETENTION_DAYS * 86_400,
        ),
      )
    : 0;
  return {
    healthy:
      (!maintenanceRequired || fresh(worker?.lastSeenAt)) &&
      (!notificationEnabled ||
        (fresh(dispatch?.lastSeenAt) &&
          blocked + blockedReplies === 0 &&
          outbox.status !== 'critical')) &&
      (config.FEEDBACK_RETENTION_DAYS === 0 || (fresh(retention?.lastSeenAt) && overdueSeconds < 300)),
    workerRequired: maintenanceRequired,
    workerFresh: fresh(worker?.lastSeenAt),
    dispatchFresh: fresh(dispatch?.lastSeenAt),
    retentionFresh: fresh(retention?.lastSeenAt),
    pending,
    pendingReplies: replies,
    blocked,
    blockedReplies,
    retentionOverdueSeconds: overdueSeconds,
    ...outbox,
  };
}
