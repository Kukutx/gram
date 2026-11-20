import { Composer } from 'grammy';
import { beginFeedback, cancelFeedback, consumeFeedback, expireFeedback } from '../../db/repository.ts';
import { myTickets } from '../../db/tickets.ts';
import { validateFeedback } from '../../domain/feedback.ts';
import { ticketStatusLabel } from '../../domain/i18n.ts';
import { truncateTelegramText } from '../../domain/telegram-text.ts';
import { reportError } from '../../observability/errors.ts';
import { notificationEnqueueFailures } from '../../observability/metrics.ts';
import { isPrivateChat, type BotContext, type BotDeps } from '../context.ts';

const VALIDATION_KEYS = {
  empty: 'feedbackEmpty',
  too_long: 'feedbackTooLong',
  command: 'feedbackCommand',
} as const;

function feedbackState(ctx: BotContext): 'none' | 'active' | 'expired' {
  const user = ctx.user;
  if (!user?.awaitingFeedback) return 'none';
  return user.feedbackExpiresAt && user.feedbackExpiresAt > new Date() ? 'active' : 'expired';
}

/** User-side feedback flow: /feedback → one text message → saved and queued for admins. */
export function feedbackFeature({ db, notifications, logger }: BotDeps): Composer<BotContext> {
  const composer = new Composer<BotContext>();

  /**
   * Feedback is committed in PostgreSQL before we try to queue a notice. The queue is only
   * an accelerator: the worker scans unnotified rows, so a Redis outage must neither make
   * Telegram replay an already-saved message nor hide the success reply from the user.
   */
  async function enqueueBestEffort(feedbackId: string): Promise<void> {
    if (!notifications) return;
    try {
      await notifications.enqueueFeedback(feedbackId);
    } catch (error) {
      notificationEnqueueFailures.inc();
      logger.warn(
        { err: error, feedbackId },
        'Notification enqueue failed; worker will reconcile outbox',
      );
      reportError(error);
    }
  }

  composer.command(['feedback', 'cancel', 'my_feedbacks'], (ctx, next) =>
    isPrivateChat(ctx) ? next() : ctx.reply(ctx.t('privateOnly')),
  );
  const pm = composer.chatType('private');

  pm.command('feedback', async (ctx) => {
    await beginFeedback(db, ctx.from.id, ctx.update.update_id);
    await ctx.reply(ctx.t('feedbackAsk'));
  });

  pm.command('cancel', async (ctx) => {
    const canceled = await cancelFeedback(db, ctx.from.id, ctx.update.update_id);
    await ctx.reply(ctx.t(canceled ? 'canceled' : 'nothingToCancel'));
  });

  pm.command('my_feedbacks', async (ctx) => {
    const rows = await myTickets(db, ctx.from.id);
    const text = rows.length
      ? rows
          .map((row) =>
            ctx.t('myTicketRow', {
              id: row.id,
              status: ticketStatusLabel(ctx.lang, row.status),
              createdAt: row.createdAt.toISOString(),
              replies: row._count.replies,
            }),
          )
          .join('\n\n')
      : ctx.t('feedbackListEmpty');
    await ctx.reply(truncateTelegramText(text, 4096));
  });

  pm.on('message:text', async (ctx) => {
    const state = feedbackState(ctx);
    if (state === 'none') {
      // A prior attempt may have saved this update's feedback but failed before replying.
      // Telegram's retry must still repair the notice after the pending state was cleared.
      const saved = await db.feedback.findUnique({
        where: { sourceUpdateId: ctx.update.update_id },
        select: { id: true },
      });
      if (!saved) return ctx.reply(ctx.t('unknown'));
      await enqueueBestEffort(saved.id);
      return ctx.reply(ctx.t('feedbackSaved'));
    }
    if (state === 'expired') {
      await expireFeedback(db, ctx.from.id);
      return ctx.reply(ctx.t('feedbackExpired'));
    }
    const validated = validateFeedback(ctx.message.text);
    if (!validated.ok) return ctx.reply(ctx.t(VALIDATION_KEYS[validated.reason]));
    const feedback = await consumeFeedback(db, ctx.from.id, ctx.update.update_id, validated.text);
    // Another in-flight update consumed the pending input first.
    if (!feedback) return ctx.reply(ctx.t('nothingToCancel'));
    await enqueueBestEffort(feedback.id);
    await ctx.reply(ctx.t('feedbackSavedWithId', { id: feedback.id }));
  });

  pm.on('message', async (ctx) => {
    if (feedbackState(ctx) === 'active') await ctx.reply(ctx.t('feedbackTextOnly'));
  });

  return composer;
}
