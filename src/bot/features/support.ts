import { Composer } from 'grammy';
import {
  addStaffMessage,
  changeTicket,
  ticketForDeliveredMessage,
  ticketForThread,
  ticketOwner,
  type StatusAction,
} from '../../db/tickets.ts';
import { extractContent, validateContent } from '../../domain/content.ts';
import { ticketStatusLabel } from '../../domain/i18n.ts';
import type { BotContext, BotDeps } from '../context.ts';
import { statusNotice } from '../recipients.ts';

const VALIDATION_KEYS = {
  empty: 'feedbackEmpty',
  too_long: 'feedbackTooLong',
  command: 'feedbackCommand',
} as const;

/**
 * Staff side of the conversation without commands: replying to a ticket
 * notification, or writing inside a ticket's forum topic, sends that message
 * (text or attachment) to the user. Notification buttons change the status.
 */
export function supportFeature({ config, db }: BotDeps): Composer<BotContext> {
  const composer = new Composer<BotContext>();
  const notice = statusNotice(config);

  composer.callbackQuery(/^tk:(\d{1,9}):(assign|resolved|closed)$/, async (ctx) => {
    if (!ctx.isAdmin) return ctx.answerCallbackQuery({ text: ctx.t('forbidden') });
    const number = Number(ctx.match[1]);
    const action = ctx.match[2] as StatusAction;
    const result = await changeTicket(db, ctx.from.id, ctx.update.update_id, { number }, action, notice);
    const status = action === 'assign' ? 'in_progress' : action;
    const text =
      result === 'saved'
        ? ctx.t('callbackDone', { number, status: ticketStatusLabel(ctx.lang, status) })
        : ctx.t(
            result === 'missing'
              ? 'ticketMissing'
              : result === 'stale'
                ? 'alreadyHandled'
                : 'ticketUnchanged',
          );
    await ctx.answerCallbackQuery({ text });
  });

  /** The ticket a staff message belongs to, or null when it is ordinary chatter. */
  async function ticketFor(ctx: BotContext) {
    const message = ctx.message!;
    const chatId = ctx.chat!.id;
    const replyTo = message.reply_to_message;
    const topicRoot = message.is_topic_message && replyTo?.message_id === message.message_thread_id;
    if (replyTo && !topicRoot && replyTo.from?.id === ctx.me.id) {
      const ticket = await ticketForDeliveredMessage(db, chatId, replyTo.message_id);
      if (ticket) {
        // An admin may also be a user: a reply to their own ticket's update is a user follow-up.
        if (!ctx.inSupportChat && (await ticketOwner(db, { id: ticket.id })) === ctx.from!.id)
          return undefined;
        return ticket;
      }
      return null;
    }
    if (ctx.inSupportChat && message.is_topic_message && message.message_thread_id !== undefined)
      return ticketForThread(db, message.message_thread_id);
    return undefined;
  }

  composer.on('message', async (ctx, next) => {
    if (!ctx.isAdmin || ctx.from.is_bot) return next();
    const ticket = await ticketFor(ctx);
    // Not a ticket conversation: private chats fall through to intake; group chatter is ignored.
    if (ticket === undefined) return ctx.inSupportChat ? undefined : next();
    if (ticket === null) return ctx.reply(ctx.t('replyNoTicket'));
    const content = extractContent(ctx.message);
    if (!content) return ctx.inSupportChat ? undefined : ctx.reply(ctx.t('unsupportedContent'));
    const validated = validateContent(content);
    if (!validated.ok) {
      // Unknown commands typed in a topic are not meant for the user.
      if (validated.reason === 'command') return;
      return ctx.reply(ctx.t(VALIDATION_KEYS[validated.reason]));
    }
    const result = await addStaffMessage(
      db,
      ctx.from.id,
      ctx.update.update_id,
      { id: ticket.id },
      validated.content,
    );
    if (result.kind === 'missing') return ctx.reply(ctx.t('ticketMissing'));
    if (result.kind === 'closed') return ctx.reply(ctx.t('ticketClosed'));
    if (result.kind === 'queued')
      await ctx.react('👌').catch(() => ctx.reply(ctx.t('replyQueued', { number: result.number })));
  });

  return composer;
}
