import { randomUUID } from 'node:crypto';
import type { Api } from 'grammy';
import type { AbortSignal } from 'abort-controller';
import type { Database } from '../db/client.ts';
import type { Logger } from '../observability/logger.ts';
import { safeError } from '../observability/logger.ts';
import { reportError } from '../observability/errors.ts';
import { buildFeedbackNotification, truncateTelegramText } from '../domain/telegram-text.ts';
import { DELIVERY_LEASE_MS } from '../db/notification-lease.ts';

export type NotificationJob = { feedbackId: string } | { replyId: string };

/** The same processor is used by BullMQ and the PostgreSQL-only dispatcher. */
export async function deliverNotification(
  db: Database,
  api: Api,
  admin: number,
  job: NotificationJob,
  logger: Logger,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  const token = randomUUID();
  const replyJob = 'replyId' in job;
  const id = replyJob ? job.replyId : job.feedbackId;
  const now = new Date();
  const claim = {
    where: {
      id,
      notifiedAt: null,
      deliveryStatus: 'pending',
      OR: [{ deliveryLeaseUntil: null }, { deliveryLeaseUntil: { lte: now } }],
    },
    data: {
      deliveryLeaseToken: token,
      deliveryLeaseUntil: new Date(now.getTime() + DELIVERY_LEASE_MS),
      deliveryAttempts: { increment: 1 },
    },
  };
  const claimed = replyJob
    ? await db.feedbackReply.updateMany(claim)
    : await db.feedback.updateMany(claim);
  if (!claimed.count) return;
  try {
    let text: string;
    let chatId: number;
    if (replyJob) {
      const reply = await db.feedbackReply.findUnique({
        where: { id },
        include: { feedback: { include: { user: true } } },
      });
      if (!reply) return;
      chatId = Number(reply.feedback.user.telegramId);
      text = truncateTelegramText(`💬 ${reply.feedbackId}\n\n${reply.text}`, 4096);
    } else {
      const feedback = await db.feedback.findUnique({ where: { id }, include: { user: true } });
      if (!feedback) return;
      chatId = admin;
      text = buildFeedbackNotification(
        feedback.user.username ? `@${feedback.user.username}` : String(feedback.user.telegramId),
        id,
        feedback.text,
      );
    }
    await api.sendMessage(chatId, text, { link_preview_options: { is_disabled: true } }, signal);
    const mark = {
      where: { id, deliveryLeaseToken: token },
      data: {
        notifiedAt: new Date(),
        deliveryStatus: 'sent',
        deliveryLeaseToken: null,
        deliveryLeaseUntil: null,
        lastDeliveryErrorCode: null,
      },
    };
    const marked = replyJob
      ? await db.feedbackReply.updateMany(mark)
      : await db.feedback.updateMany(mark);
    if (!marked.count) logger.warn('Notification owner changed before confirmation');
    logger.info({ kind: replyJob ? 'reply' : 'feedback' }, 'Notification delivered');
  } catch (error) {
    const safe = safeError(error);
    const code = typeof safe.code === 'number' ? safe.code : null;
    const permanent = code === 400 || code === 401 || code === 403;
    const fail = {
      where: { id, deliveryLeaseToken: token },
      data: {
        deliveryStatus: permanent ? 'blocked' : 'pending',
        lastDeliveryErrorCode: code,
        lastDeliveryErrorAt: new Date(),
        deliveryLeaseToken: null,
        // Durable cooldown also applies without Redis. Lease doubles as next attempt time.
        deliveryLeaseUntil: permanent ? null : new Date(Date.now() + 60_000),
      },
    };
    if (replyJob) await db.feedbackReply.updateMany(fail);
    else await db.feedback.updateMany(fail);
    logger.error(
      { err: error, kind: replyJob ? 'reply' : 'feedback' },
      permanent ? 'Delivery blocked; operator action required' : 'Delivery failed; will retry',
    );
    reportError(error);
    if (!permanent) throw error;
  }
}
