import { Composer, InlineKeyboard, InputFile } from 'grammy';
import { getMyDataSummary } from '../../db/users.ts';
import {
  decodeExportCursor,
  getPersonalDataExportPage,
  type ExportCursor,
} from '../../privacy/export.ts';
import {
  cancelDeleteConfirmation,
  confirmationNonce,
  consumeDeleteConfirmation,
  issueDeleteConfirmation,
} from '../../privacy/delete-confirm.ts';
import { LANGUAGE_LABELS, normalizeLanguage } from '../../domain/i18n.ts';
import type { BotContext, BotDeps } from '../context.ts';
import { shortTime } from '../render.ts';

const PRIVACY_COMMANDS = ['my_data', 'export_my_data', 'export_my_replies', 'delete_my_data'];

/** Personal-data inventory, paginated export and confirmed erasure. Private chats only. */
export function privacyFeature({ config, db, rateLimiter, logger }: BotDeps): Composer<BotContext> {
  const composer = new Composer<BotContext>();
  const pm = composer.chatType('private');
  composer.command(PRIVACY_COMMANDS, (ctx) => ctx.reply(ctx.t('privateOnly')));

  pm.command('my_data', async (ctx) => {
    const data = await getMyDataSummary(db, ctx.from.id);
    if (!data) return; // The user record can be deleted by another update.
    await ctx.reply(
      ctx.t('myData', {
        userId: ctx.from.id,
        ticketCount: data.ticketCount,
        messageCount: data.messageCount,
        createdAt: shortTime(data.createdAt, config.TIME_ZONE),
        lastSeenAt: shortTime(data.lastSeenAt, config.TIME_ZONE),
        language: LANGUAGE_LABELS[normalizeLanguage(data.language, config.DEFAULT_LANGUAGE)],
      }),
    );
  });

  const parseCursor = async (
    ctx: BotContext,
    raw: string,
  ): Promise<ExportCursor | undefined | false> => {
    try {
      return decodeExportCursor(raw);
    } catch {
      await ctx.reply(ctx.t('exportInvalidCursor'));
      return false;
    }
  };

  // `export_my_replies` is the v1 name; the v2 export already contains both directions.
  pm.command(['export_my_data', 'export_my_replies'], async (ctx) => {
    const cursor = await parseCursor(ctx, ctx.match);
    if (cursor === false) return;
    const page = await getPersonalDataExportPage(db, ctx.from.id, cursor);
    if (!page) return ctx.reply(ctx.t('exportNoData'));
    await ctx.replyWithDocument(new InputFile(page.fileContents, 'telegram-my-data.json'));
    await ctx.reply(
      page.nextCursor
        ? ctx.t('exportNext', { command: `/export_my_data ${page.nextCursor}` })
        : ctx.t('exportDone'),
    );
  });

  // Deletion is destructive: require a user-bound, short-lived confirmation.
  // The Bot Token signs the callback; PostgreSQL stores and consumes its nonce across instances.
  pm.command('delete_my_data', async (ctx) => {
    const confirm = await issueDeleteConfirmation(
      db,
      ctx.from.id,
      ctx.update.update_id,
      config.BOT_TOKEN,
    );
    if (confirm === 'stale') return ctx.reply(ctx.t('alreadyHandled'));
    const keyboard = new InlineKeyboard()
      .text(ctx.t('deleteConfirmYes'), confirm)
      .text(ctx.t('deleteConfirmCancel'), `erase:cancel:${confirmationNonce(confirm)}`);
    await ctx.reply(ctx.t('deleteConfirmPrompt'), { reply_markup: keyboard });
  });

  async function dismissKeyboard(ctx: BotContext): Promise<void> {
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    } catch {
      // The message may be gone: never undo a successful deletion because of UI cleanup.
    }
  }

  async function answerBestEffort(ctx: BotContext, text?: string): Promise<void> {
    try {
      await ctx.answerCallbackQuery(text ? { text, show_alert: true } : {});
    } catch (error) {
      logger.warn({ err: error }, 'Callback acknowledgement failed');
    }
  }

  pm.callbackQuery(/^erase:cancel:([A-Za-z0-9_-]{16})$/, async (ctx) => {
    await cancelDeleteConfirmation(db, ctx.from.id, ctx.match[1]!);
    await answerBestEffort(ctx);
    await dismissKeyboard(ctx);
    await ctx.reply(ctx.t('deleteCanceled'));
  });

  pm.callbackQuery(/^erase:v2:/, async (ctx) => {
    // Database deletion happens first; acknowledging the button is best effort.
    if (!(await consumeDeleteConfirmation(db, ctx.from.id, ctx.callbackQuery.data, config.BOT_TOKEN)))
      return answerBestEffort(ctx, ctx.t('deleteInvalidConfirmation'));
    await rateLimiter?.forget(ctx.from.id);
    await answerBestEffort(ctx);
    await dismissKeyboard(ctx);
    await ctx.reply(ctx.t('deleted'));
  });

  composer.callbackQuery(/^erase:/, (ctx) => answerBestEffort(ctx, ctx.t('deleteInvalidConfirmation')));

  return composer;
}
