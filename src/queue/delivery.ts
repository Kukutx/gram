import { randomUUID } from 'node:crypto';
import type { Api } from 'grammy';
import type { AbortSignal } from 'abort-controller';
import type { Database } from '../db/client.ts';
import type { Logger } from '../observability/logger.ts';
import { safeError } from '../observability/logger.ts';
import { reportError } from '../observability/errors.ts';
import { buildFeedbackNotification, withHeader } from '../domain/telegram-text.ts';
import { normalizeLanguage, t, type Language } from '../domain/i18n.ts';
import { claimDelivery, markDelivered, markDeliveryFailed } from '../db/notification-lease.ts';

export type NotificationJob = { feedbackId: string } | { replyId: string };

/** Telegram rejects these for good (bad request, revoked token, user blocked the bot). */
const PERMANENT_ERROR_CODES = new Set([400, 401, 403]);

type Outbound = { chatId: number; text: string };

async function loadOutbound(
  db: Database,
  job: NotificationJob,
  admin: number,
  adminLanguage: Language,
): Promise<Outbound | null> {
  if ('replyId' in job) {
    const reply = await db.feedbackReply.findUnique({
      where: { id: job.replyId },
      select: {
        feedbackId: true,
        text: true,
        feedback: { select: { user: { select: { telegramId: true, language: true } } } },
      },
    });
    if (!reply) return null;
    const user = reply.feedback.user;
    const language = normalizeLanguage(user.language);
    return {
      chatId: Number(user.telegramId),
      text: withHeader(t(language, 'notifyReply', { id: reply.feedbackId }), reply.text),
    };
  }
  const feedback = await db.feedback.findUnique({
    where: { id: job.feedbackId },
    select: { text: true, user: { select: { telegramId: true, username: true } } },
  });
  if (!feedback) return null;
  const author = feedback.user.username
    ? `@${feedback.user.username}`
    : String(feedback.user.telegramId);
  return {
    chatId: admin,
    text: buildFeedbackNotification(author, job.feedbackId, feedback.text, adminLanguage),
  };
}

/**
 * The same processor is used by BullMQ and the PostgreSQL-only dispatcher.
 * Lease → load → send → confirm. A temporary failure rethrows so a queue can back off.
 */
export async function deliverNotification(
  db: Database,
  api: Api,
  admin: number,
  job: NotificationJob,
  logger: Logger,
  signal?: AbortSignal,
  adminLanguage: Language = 'zh',
): Promise<void> {
  if (signal?.aborted) return;
  const kind = 'replyId' in job ? 'reply' : 'feedback';
  const id = 'replyId' in job ? job.replyId : job.feedbackId;
  const token = randomUUID();
  if (!(await claimDelivery(db, kind, id, token))) return;
  try {
    // A row deleted after the claim (erasure/retention) is simply gone: nothing to send.
    const outbound = await loadOutbound(db, job, admin, adminLanguage);
    if (!outbound) return;
    await api.sendMessage(
      outbound.chatId,
      outbound.text,
      { link_preview_options: { is_disabled: true } },
      signal,
    );
    if (!(await markDelivered(db, kind, id, token)))
      logger.warn({ kind }, 'Notification owner changed before confirmation');
    else logger.info({ kind }, 'Notification delivered');
  } catch (error) {
    const safe = safeError(error);
    const code = typeof safe.code === 'number' ? safe.code : null;
    const permanent = code !== null && PERMANENT_ERROR_CODES.has(code);
    await markDeliveryFailed(db, kind, id, token, { code, permanent });
    logger.error(
      { err: error, kind },
      permanent ? 'Delivery blocked; operator action required' : 'Delivery failed; will retry',
    );
    reportError(error);
    if (!permanent) throw error;
  }
}
