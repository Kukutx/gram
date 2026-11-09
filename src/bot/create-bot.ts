import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { Menu, type MenuFlavor } from '@grammyjs/menu';
import type { AppConfig } from '../config/env.ts';
import { adminId } from '../config/env.ts';
import type { Database } from '../db/client.ts';
import {
  beginFeedback,
  cancelFeedback,
  consumeFeedback,
  countStats,
  expireFeedback,
  getFeedbackState,
  getLanguage,
  getMyDataSummary,
  listFeedback,
  setLanguage,
  touchUser,
} from '../db/repository.ts';
import { summarizeFeedback, validateFeedback } from '../domain/feedback.ts';
import {
  decodeExportCursor,
  getPersonalDataExportPage,
  getPersonalReplyExportPage,
} from '../privacy/export.ts';
import {
  issueDeleteConfirmation,
  consumeDeleteConfirmation,
  cancelDeleteConfirmation,
  confirmationNonce,
} from '../privacy/delete-confirm.ts';
import { reportError } from '../observability/errors.ts';
import { operationsHealth } from '../observability/operations.ts';
import { registerTicketCommands } from './tickets.ts';
import { t, type Language } from '../domain/i18n.ts';
import {
  notificationEnqueueFailures,
  processedUpdates,
  throttledUpdates,
  updateDuration,
} from '../observability/metrics.ts';
import { isPrivacyCommand, isPrivacyCallback, type RateLimiter } from '../security/rate-limit.ts';
import type { Logger } from '../observability/logger.ts';
import type { Notifications } from '../queue/notifications.ts';

export type BotContext = Context & MenuFlavor;

export type BotDeps = {
  config: AppConfig;
  db: Database;
  notifications?: Notifications;
  rateLimiter?: RateLimiter;
  logger: Logger;
};

const privateChat = (ctx: Context): boolean => ctx.chat?.type === 'private' && ctx.from !== undefined;

function isAdmin(ctx: Context, config: AppConfig): boolean {
  const configuredAdmin = adminId(config);
  return configuredAdmin !== undefined && ctx.from?.id === configuredAdmin;
}

/** Produces one, and only one, Telegram Bot instance for the application. */
export function createBot({ config, db, notifications, rateLimiter, logger }: BotDeps): Bot<BotContext> {
  const bot = new Bot<BotContext>(config.BOT_TOKEN, {
    client: { timeoutSeconds: config.BOT_MODE === 'polling' ? 60 : 8 },
  });
  const warned = new Map<number, number>();

  /**
   * Feedback is committed in PostgreSQL before we attempt to queue a notice.
   * Queue publication is only a delivery accelerator: the independent worker
   * scans unnotified rows and repairs missing or terminal Redis jobs.
   * A Redis outage must therefore not make Telegram replay an already-saved
   * message or prevent the user from receiving a success response.
   */
  async function enqueueFeedbackBestEffort(feedbackId: string): Promise<void> {
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
  bot.api.config.use(autoRetry({ maxRetryAttempts: 2, maxDelaySeconds: 5 }));

  // No update contents (messages, usernames, etc.) are written to logs.
  bot.use(async (ctx, next) => {
    const finish = updateDuration.startTimer();
    const id = ctx.update.update_id;
    try {
      await next();
      processedUpdates.inc({ result: 'ok' });
      logger.debug({ updateId: id }, 'Telegram update handled');
    } catch (error) {
      processedUpdates.inc({ result: 'error' });
      logger.error({ err: error, updateId: id }, 'Telegram update failed');
      throw error;
    } finally {
      finish();
    }
  });

  // Distributed Redis limit, or bounded process-local fallback when Redis is absent.
  // Never block requests to erase personal data or read the privacy notice.
  bot.use(async (ctx, next) => {
    if (
      privateChat(ctx) &&
      ctx.from &&
      !isAdmin(ctx, config) &&
      !isPrivacyCommand(ctx.message?.text) &&
      !isPrivacyCallback(
        ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined,
      )
    ) {
      if (rateLimiter && !(await rateLimiter.allow(ctx.from.id))) {
        throttledUpdates.inc();
        const now = Date.now();
        if (now - (warned.get(ctx.from.id) ?? 0) > 60_000) {
          if (warned.size > 20_000) warned.clear();
          warned.set(ctx.from.id, now);
          await ctx.reply(t(await locale(ctx), 'rateLimited'));
        }
        return;
      }
    }
    await next();
  });

  // Store only the minimum details needed for private-chat features.
  bot.use(async (ctx, next) => {
    if (privateChat(ctx) && ctx.from) {
      const callback =
        ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
      // Stale privacy callbacks must not recreate an erased account.
      if (!callback?.startsWith('erase:')) {
        const receipt = await db.commandReceipt.findUnique({
          where: { updateId: ctx.update.update_id },
          select: { updateId: true },
        });
        if (receipt) {
          await ctx.reply(t(await locale(ctx), 'alreadyHandled'));
          return;
        }
        await touchUser(db, ctx.from);
      }
    }
    await next();
  });

  const languageMenu = new Menu<BotContext>('language-settings')
    .text('🇨🇳 简体中文', async (ctx) => {
      if (!ctx.from || !privateChat(ctx)) return;
      await setLanguage(db, ctx.from.id, 'zh', ctx.update.update_id);
      ctx.menu.close();
      await ctx.reply(t('zh', 'languageSaved'));
    })
    .row()
    .text('🇬🇧 English', async (ctx) => {
      if (!ctx.from || !privateChat(ctx)) return;
      await setLanguage(db, ctx.from.id, 'en', ctx.update.update_id);
      ctx.menu.close();
      await ctx.reply(t('en', 'languageSaved'));
    });
  bot.use(languageMenu);

  async function locale(ctx: Context): Promise<Language> {
    return privateChat(ctx) && ctx.from ? getLanguage(db, ctx.from.id) : 'zh';
  }

  async function requirePrivate(ctx: Context): Promise<boolean> {
    if (privateChat(ctx)) return true;
    await ctx.reply(t('zh', 'privateOnly'));
    return false;
  }

  bot.command('start', async (ctx) => ctx.reply(t(await locale(ctx), 'welcome')));
  bot.command('help', async (ctx) => {
    const lang = await locale(ctx);
    await ctx.reply(`${t(lang, 'help')}\n\n${t(lang, 'ticketHelp')}`);
  });
  bot.command('ping', async (ctx) => ctx.reply(t(await locale(ctx), 'ping')));
  bot.command('id', async (ctx) =>
    ctx.reply(
      t(await locale(ctx), 'id', {
        userId: ctx.from?.id ?? 'unknown',
        chatId: ctx.chat.id,
      }),
    ),
  );
  bot.command('privacy', async (ctx) => {
    const lang = await locale(ctx);
    const retentionNotice =
      config.FEEDBACK_RETENTION_DAYS > 0
        ? t(lang, 'retentionEnabled', { days: config.FEEDBACK_RETENTION_DAYS })
        : t(lang, 'retentionDisabled');
    const policy = config.PRIVACY_POLICY_URL ? `\n${config.PRIVACY_POLICY_URL}` : '';
    await ctx.reply(
      `${t(lang, 'privacy')}\n\n${retentionNotice}\n${t(lang, 'privacyCopies')}\n${t(lang, 'privacyContact', { contact: config.SUPPORT_CONTACT ?? '/feedback' })}${policy}`,
      { link_preview_options: { is_disabled: true } },
    );
  });

  bot.command('my_data', async (ctx) => {
    if (!(await requirePrivate(ctx)) || !ctx.from) return;
    const data = await getMyDataSummary(db, ctx.from.id);
    if (!data) return; // The user record can be deleted by another update.
    await ctx.reply(
      t(await locale(ctx), 'myData', {
        userId: ctx.from.id,
        feedbackCount: data._count.feedback,
        createdAt: data.createdAt.toISOString(),
        lastSeenAt: data.lastSeenAt.toISOString(),
        language: data.language,
      }),
    );
  });

  bot.command('export_my_data', async (ctx) => {
    if (!(await requirePrivate(ctx)) || !ctx.from) return;
    const lang = await locale(ctx);
    let cursor;
    try {
      cursor = decodeExportCursor(ctx.match);
    } catch {
      await ctx.reply(t(lang, 'exportInvalidCursor'));
      return;
    }
    const page = await getPersonalDataExportPage(db, ctx.from.id, cursor);
    if (!page) {
      await ctx.reply(t(lang, 'exportNoData'));
      return;
    }
    // A page has at most 50 feedback entries. It fits in a small Telegram
    // document and avoids synchronously loading unlimited personal history.
    await ctx.replyWithDocument(new InputFile(page.fileContents, 'telegram-my-data.json'));
    if (page.nextCursor) {
      await ctx.reply(t(lang, 'exportNext', { command: `/export_my_data ${page.nextCursor}` }));
    } else {
      await ctx.reply(t(lang, 'exportDone'));
      await ctx.reply(t(lang, 'exportReplies'));
    }
  });

  bot.command('export_my_replies', async (ctx) => {
    if (!(await requirePrivate(ctx)) || !ctx.from) return;
    const lang = await locale(ctx);
    try {
      const cursor = decodeExportCursor(ctx.match);
      const page = await getPersonalReplyExportPage(db, ctx.from.id, cursor);
      await ctx.replyWithDocument(new InputFile(page.fileContents, 'telegram-my-replies.json'));
      await ctx.reply(
        page.nextCursor
          ? t(lang, 'exportNext', { command: `/export_my_replies ${page.nextCursor}` })
          : t(lang, 'exportDone'),
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'Invalid export cursor')
        await ctx.reply(t(lang, 'exportInvalidCursor'));
      else throw error;
    }
  });

  bot.command('settings', async (ctx) => {
    if (!(await requirePrivate(ctx))) return;
    await ctx.reply(t(await locale(ctx), 'settings'), { reply_markup: languageMenu });
  });

  bot.command('feedback', async (ctx) => {
    if (!(await requirePrivate(ctx)) || !ctx.from) return;
    await beginFeedback(db, ctx.from.id, ctx.update.update_id);
    await ctx.reply(t(await locale(ctx), 'feedbackAsk'));
  });

  bot.command('cancel', async (ctx) => {
    if (!(await requirePrivate(ctx)) || !ctx.from) return;
    const canceled = await cancelFeedback(db, ctx.from.id, ctx.update.update_id);
    await ctx.reply(t(await locale(ctx), canceled ? 'canceled' : 'nothingToCancel'));
  });

  // Deletion is destructive: require a user-bound, short-lived confirmation.
  // The Bot Token signs the callback; PostgreSQL stores and consumes its nonce across instances.
  bot.command('delete_my_data', async (ctx) => {
    if (!(await requirePrivate(ctx)) || !ctx.from) return;
    const lang = await locale(ctx);
    const confirm = await issueDeleteConfirmation(
      db,
      ctx.from.id,
      ctx.update.update_id,
      config.BOT_TOKEN,
    );
    if (confirm === 'stale') {
      await ctx.reply(t(lang, 'alreadyHandled'));
      return;
    }
    const keyboard = new InlineKeyboard()
      .text(t(lang, 'deleteConfirmYes'), confirm)
      .text(t(lang, 'deleteConfirmCancel'), `erase:cancel:${confirmationNonce(confirm)}`);
    await ctx.reply(t(lang, 'deleteConfirmPrompt'), { reply_markup: keyboard });
  });

  async function dismissConfirmation(ctx: BotContext): Promise<void> {
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    } catch {
      // Message may have been deleted: do not undo a successful data deletion.
    }
  }

  async function answerBestEffort(ctx: BotContext, text?: string): Promise<void> {
    try {
      await ctx.answerCallbackQuery(text ? { text, show_alert: true } : {});
    } catch (error) {
      logger.warn({ err: error }, 'Callback acknowledgement failed');
    }
  }

  bot.callbackQuery(/^erase:cancel:([A-Za-z0-9_-]{16})$/, async (ctx) => {
    if (!privateChat(ctx) || !ctx.from) return;
    const lang = await locale(ctx);
    await cancelDeleteConfirmation(db, ctx.from.id, ctx.match[1]!);
    await answerBestEffort(ctx);
    await dismissConfirmation(ctx);
    await ctx.reply(t(lang, 'deleteCanceled'));
  });

  bot.callbackQuery(/^erase:v2:/, async (ctx) => {
    if (!privateChat(ctx) || !ctx.from) return;
    const lang = await locale(ctx);
    if (!(await consumeDeleteConfirmation(db, ctx.from.id, ctx.callbackQuery.data, config.BOT_TOKEN))) {
      await answerBestEffort(ctx, t(lang, 'deleteInvalidConfirmation'));
      return;
    }
    await rateLimiter?.forget(ctx.from.id);
    await answerBestEffort(ctx);
    await dismissConfirmation(ctx);
    await ctx.reply(t(lang, 'deleted'));
  });
  bot.callbackQuery(/^erase:/, async (ctx) => {
    await answerBestEffort(ctx, t(await locale(ctx), 'deleteInvalidConfirmation'));
  });

  bot.command('stats', async (ctx) => {
    if (!isAdmin(ctx, config) || !privateChat(ctx)) {
      await ctx.reply(t(await locale(ctx), 'forbidden'));
      return;
    }
    const stats = await countStats(db);
    await ctx.reply(t(await locale(ctx), 'stats', stats));
  });

  bot.command('status', async (ctx) => {
    if (!isAdmin(ctx, config) || !privateChat(ctx)) {
      await ctx.reply(t(await locale(ctx), 'forbidden'));
      return;
    }
    const health = await operationsHealth(db, config);
    const queueStatus = notifications
      ? (await notifications.isReady())
        ? 'online'
        : 'unavailable'
      : 'postgresql';
    await ctx.reply(
      t(await locale(ctx), 'status', {
        pending: health.pending + health.pendingReplies,
        health: health.status,
        oldestSeconds: health.oldestPendingAgeSeconds ?? 'n/a',
        queue: queueStatus,
      }) +
        `\nWorker: ${health.workerFresh}\nDispatch: ${health.dispatchFresh}\nRetention: ${health.retentionFresh}\nBlocked: ${health.blocked + health.blockedReplies}`,
    );
  });

  bot.command('feedbacks', async (ctx) => {
    if (!isAdmin(ctx, config) || !privateChat(ctx)) {
      await ctx.reply(t(await locale(ctx), 'forbidden'));
      return;
    }
    const feedbacks = await listFeedback(db);
    const lang = await locale(ctx);
    if (feedbacks.length === 0) {
      await ctx.reply(t(lang, 'feedbackListEmpty'));
      return;
    }
    const lines = feedbacks.map((item, index) => {
      const author = item.user.username ? `@${item.user.username}` : String(item.user.telegramId);
      return `${index + 1}. ${item.id} [${item.status}]\n${item.createdAt.toISOString()} • ${author}\n${summarizeFeedback(item.text)}`;
    });
    await ctx.reply(`${t(lang, 'feedbackListTitle')}\n\n${lines.join('\n\n')}`, {
      link_preview_options: { is_disabled: true },
    });
  });

  registerTicketCommands(bot, { config, db, logger, notifications });

  bot.on('message:text', async (ctx) => {
    if (!privateChat(ctx) || !ctx.from) return;
    const lang = await locale(ctx);
    const state = await getFeedbackState(db, ctx.from.id);
    if (state === 'none') {
      // A prior attempt can have saved the feedback but failed during queue submission.
      // Telegram retries must be able to repair that gap after the pending state is cleared.
      const saved = await db.feedback.findUnique({
        where: { sourceUpdateId: ctx.update.update_id },
        select: { id: true },
      });
      if (saved) {
        await enqueueFeedbackBestEffort(saved.id);
        await ctx.reply(t(lang, 'feedbackSaved'));
      } else {
        await ctx.reply(t(lang, 'unknown'));
      }
      return;
    }
    if (state === 'expired') {
      await expireFeedback(db, ctx.from.id);
      await ctx.reply(t(lang, 'feedbackExpired'));
      return;
    }
    const validated = validateFeedback(ctx.message.text);
    if (!validated.ok) {
      const key = {
        empty: 'feedbackEmpty',
        too_long: 'feedbackTooLong',
        command: 'feedbackCommand',
      } as const;
      await ctx.reply(t(lang, key[validated.reason]));
      return;
    }
    const feedback = await consumeFeedback(db, ctx.from.id, ctx.update.update_id, validated.text);
    if (!feedback) {
      // Another in-flight update consumed the pending input first.
      await ctx.reply(t(lang, 'nothingToCancel'));
      return;
    }
    // Persisted outbox rows are reconciled by the independent worker when Redis
    // was unavailable at commit time. Never fail a committed update just for Redis.
    await enqueueFeedbackBestEffort(feedback.id);
    await ctx.reply(`${t(lang, 'feedbackSaved')}\nID: ${feedback.id}\n/my_feedbacks`);
  });

  bot.on('message', async (ctx) => {
    if (privateChat(ctx) && ctx.from && (await getFeedbackState(db, ctx.from.id)) === 'active') {
      await ctx.reply(t(await locale(ctx), 'feedbackTextOnly'));
    }
  });

  bot.catch((error) => {
    logger.error({ err: error.error, updateId: error.ctx.update.update_id }, 'grammY error boundary');
    reportError(error.error);
    // Required: let the webhook return a 5xx so Telegram can retry transient errors.
    throw error.error;
  });

  return bot;
}
