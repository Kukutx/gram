import { Composer, InlineKeyboard } from 'grammy';
import { beginFeedback, cancelFeedback, expireFeedback } from '../../db/users.ts';
import {
  addUserMessage,
  getTicket,
  latestActiveTicket,
  myTickets,
  openTicket,
  ownTicket,
  recentlyResolvedTicket,
  ticketForDeliveredMessage,
  type OpenResult,
} from '../../db/tickets.ts';
import { extractContent, validateContent, type MessageContent } from '../../domain/content.ts';
import { ticketStatusLabel } from '../../domain/i18n.ts';
import { parseTicketRef } from '../../domain/feedback.ts';
import { truncateTelegramText } from '../../domain/telegram-text.ts';
import { isPrivateChat, type BotContext, type BotDeps } from '../context.ts';
import { adminRecipients } from '../recipients.ts';
import { messageLines, shortTime } from '../render.ts';

const VALIDATION_KEYS = {
  empty: 'feedbackEmpty',
  too_long: 'feedbackTooLong',
  command: 'feedbackCommand',
} as const;

/** A message sent this soon after a ticket was resolved may be about the same problem. */
const RESOLVED_FOLLOW_UP_MS = 7 * 24 * 60 * 60_000;

function feedbackState(ctx: BotContext): 'none' | 'active' | 'expired' {
  const user = ctx.user;
  if (!user?.awaitingFeedback) return 'none';
  return user.feedbackExpiresAt && user.feedbackExpiresAt > new Date() ? 'active' : 'expired';
}

/**
 * User side of support: /feedback opens a ticket with the next message; replying
 * to a support message adds to that ticket; any message goes to the user's ticket
 * in progress, and in `direct` intake mode opens one when there is none. Messages are committed with
 * their outbox rows in one transaction; the worker delivers them.
 */
export function intakeFeature({ config, db }: BotDeps): Composer<BotContext> {
  const composer = new Composer<BotContext>();
  const recipients = adminRecipients(config);
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
    if (!rows.length) return ctx.reply(ctx.t('ticketListEmpty'));
    const lines = rows.map((row) =>
      ctx.t('myTicketRow', {
        number: row.number,
        status: ticketStatusLabel(ctx.lang, row.status),
        updatedAt: shortTime(row.lastMessageAt, config.TIME_ZONE),
        messages: row._count.messages,
      }),
    );
    await ctx.reply(truncateTelegramText(`${lines.join('\n')}\n\n${ctx.t('myTicketsFooter')}`, 4096));
  });

  // Users may inspect their own tickets; admins already got the operator view in the admin feature.
  pm.command('ticket', async (ctx) => {
    const ref = parseTicketRef(ctx.match);
    if (!ref || !('number' in ref)) return ctx.reply(ctx.t('ticketUsage'));
    const ticket = await getTicket(db, { number: ref.number });
    if (!ticket || Number(ticket.user.telegramId) !== ctx.from.id)
      return ctx.reply(ctx.t('ticketMissing'));
    await ctx.reply(
      truncateTelegramText(
        ctx.t('userTicketDetail', {
          number: ticket.number,
          status: ticketStatusLabel(ctx.lang, ticket.status),
          createdAt: shortTime(ticket.createdAt, config.TIME_ZONE),
          messages: messageLines(ctx.t, ticket.messages, config.TIME_ZONE),
        }),
        4096,
      ),
    );
  });

  function ackText(ctx: BotContext, result: OpenResult): string {
    switch (result.kind) {
      case 'created':
        return ctx.t('ticketCreated', { number: result.number });
      case 'appended':
        return ctx.t('followUpSaved', { number: result.number });
      case 'duplicate':
        return ctx.t('feedbackSaved'); // Telegram retried an update we already stored.
      case 'stale':
        return ctx.t('alreadyHandled');
      default:
        return ctx.t('unknown');
    }
  }
  const acknowledge = (ctx: BotContext, result: OpenResult) => ctx.reply(ackText(ctx, result));

  /**
   * Command mode, a message outside any ticket: instead of only pointing at /feedback, offer
   * to send this very message, or to add it to a recently resolved ticket. The buttons carry
   * the message's update ID, so a double tap cannot create two tickets.
   */
  async function offer(
    ctx: BotContext & { from: NonNullable<BotContext['from']> },
    messageId: number,
    content: MessageContent | null,
    intro: 'offerSubmit' | 'feedbackExpired' = 'offerSubmit',
  ): Promise<unknown> {
    const validated = content ? validateContent(content) : null;
    if (!validated?.ok) {
      if (validated?.reason === 'too_long') return ctx.reply(ctx.t('feedbackTooLong'));
      return ctx.reply(ctx.t(content ? 'unknown' : 'unsupportedContent'));
    }
    const updateId = ctx.update.update_id;
    const resolved = await recentlyResolvedTicket(db, ctx.from.id, RESOLVED_FOLLOW_UP_MS);
    const keyboard = new InlineKeyboard();
    if (resolved)
      keyboard
        .text(
          ctx.t('btnAddToTicket', { number: resolved.number }),
          `uf:add:${updateId}:${resolved.number}`,
        )
        .row();
    keyboard.text(ctx.t(resolved ? 'btnNewFeedback' : 'btnSubmitFeedback'), `uf:new:${updateId}`);
    const text = resolved ? ctx.t('offerResolved', { number: resolved.number }) : ctx.t(intro);
    return ctx.reply(text, {
      reply_markup: keyboard,
      reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
    });
  }

  // The offer's buttons: the message itself comes back as the prompt's reply_to_message.
  pm.callbackQuery(/^uf:(new|add):(\d{1,15})(?::(\d{1,9}))?$/, async (ctx) => {
    const [, kind, rawUpdate, rawNumber] = ctx.match;
    const source = ctx.callbackQuery.message?.reply_to_message;
    const content = source?.from?.id === ctx.from.id ? extractContent(source) : null;
    const validated = content ? validateContent(content) : null;
    if (!validated?.ok) {
      await ctx.answerCallbackQuery({ text: ctx.t('offerExpired'), show_alert: true });
      return ctx.editMessageReplyMarkup().catch(() => {});
    }
    const sourceUpdateId = Number(rawUpdate);
    let result: OpenResult;
    if (kind === 'add') {
      const ticket = await ownTicket(db, ctx.from.id, Number(rawNumber));
      if (!ticket) return ctx.answerCallbackQuery({ text: ctx.t('ticketMissing'), show_alert: true });
      result = await addUserMessage(
        db,
        ctx.from.id,
        ctx.update.update_id,
        ticket.id,
        validated.content,
        recipients,
        sourceUpdateId,
      );
    } else {
      result = await openTicket(db, ctx.from.id, ctx.update.update_id, validated.content, recipients, {
        requireAwaiting: false,
        sourceUpdateId,
      });
    }
    await ctx.answerCallbackQuery();
    // A second tap finds the message already saved; the first one already updated the prompt.
    if (result.kind === 'duplicate') return;
    const text = ackText(ctx, result);
    await ctx.editMessageText(text).catch(() => ctx.reply(text));
  });

  pm.on('message', async (ctx) => {
    const updateId = ctx.update.update_id;
    const content = extractContent(ctx.message);
    const state = feedbackState(ctx);
    // Commands that reach this point are unknown to every feature.
    if (ctx.message.text?.startsWith('/'))
      return ctx.reply(ctx.t(state === 'active' ? 'feedbackCommand' : 'unknown'));
    const replyTo = ctx.message.reply_to_message;

    // 1. Replying to a support message continues that ticket.
    if (replyTo && replyTo.from?.id === ctx.me.id && state !== 'active') {
      const ticket = await ticketForDeliveredMessage(db, ctx.chat.id, replyTo.message_id);
      if (ticket) {
        const validated = validateContent(content);
        if (!validated.ok)
          return ctx.reply(ctx.t(content ? VALIDATION_KEYS[validated.reason] : 'unsupportedContent'));
        return acknowledge(
          ctx,
          await addUserMessage(db, ctx.from.id, updateId, ticket.id, validated.content, recipients),
        );
      }
    }

    // 2. A pending /feedback (or direct mode) opens a new ticket / continues the active one.
    if (state === 'expired') {
      await expireFeedback(db, ctx.from.id);
      if (config.INTAKE_MODE === 'command')
        return offer(ctx, ctx.message.message_id, content, 'feedbackExpired');
    }
    if (state === 'active' || config.INTAKE_MODE === 'direct') {
      if (!content) return ctx.reply(ctx.t('unsupportedContent'));
      const validated = validateContent(content);
      if (!validated.ok) return ctx.reply(ctx.t(VALIDATION_KEYS[validated.reason]));
      if (state !== 'active') {
        const active = await latestActiveTicket(db, ctx.from.id);
        if (active)
          return acknowledge(
            ctx,
            await addUserMessage(db, ctx.from.id, updateId, active.id, validated.content, recipients),
          );
      }
      const result = await openTicket(db, ctx.from.id, updateId, validated.content, recipients, {
        requireAwaiting: state === 'active',
      });
      // Lost the race to another in-flight update that consumed the pending state.
      if (result.kind === 'not_awaiting') return ctx.reply(ctx.t('nothingToCancel'));
      return acknowledge(ctx, result);
    }

    // 3. Command mode: while the user has a ticket in progress, a plain message continues it
    //    (people rarely remember to use "reply"); with none, /feedback is needed.
    if (state === 'none' && content) {
      const active = await latestActiveTicket(db, ctx.from.id);
      if (active) {
        const validated = validateContent(content);
        if (!validated.ok) return ctx.reply(ctx.t(VALIDATION_KEYS[validated.reason]));
        return acknowledge(
          ctx,
          await addUserMessage(db, ctx.from.id, updateId, active.id, validated.content, recipients),
        );
      }
    }

    // 4. Telegram retried an update whose ticket was saved before the reply failed.
    const saved = await db.ticketMessage.findUnique({
      where: { sourceUpdateId: updateId },
      select: { id: true },
    });
    if (saved) return ctx.reply(ctx.t('feedbackSaved'));
    // 5. Nothing to continue: offer to send this message to support.
    return offer(ctx, ctx.message.message_id, content);
  });

  return composer;
}
