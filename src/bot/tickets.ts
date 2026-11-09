import type { Bot } from 'grammy';
import type { BotContext, BotDeps } from './create-bot.ts';
import { adminId } from '../config/env.ts';
import { getLanguage } from '../db/repository.ts';
import {
  getTicket,
  myTickets,
  changeTicket,
  queueReply,
  controlDelivery,
  validTicketId,
  TICKET_STATUSES,
  DELIVERY_ACTIONS,
  type TicketStatus,
  type DeliveryAction,
} from '../db/tickets.ts';
import { validateFeedback } from '../domain/feedback.ts';
import { truncateTelegramText } from '../domain/telegram-text.ts';
import { reportError } from '../observability/errors.ts';
import { t } from '../domain/i18n.ts';

export function registerTicketCommands(
  bot: Bot<BotContext>,
  { config, db, logger, notifications }: BotDeps,
) {
  const lang = (ctx: BotContext) => getLanguage(db, ctx.from!.id);
  const authorized = async (ctx: BotContext) => {
    const admin = adminId(config);
    if (admin !== undefined && ctx.chat?.type === 'private' && ctx.from?.id === admin) return true;
    await ctx.reply(t('zh', 'forbidden'));
    return false;
  };
  const safeReply = (ctx: BotContext, text: string) =>
    ctx.reply(truncateTelegramText(text, 4096), { link_preview_options: { is_disabled: true } });

  bot.command('my_feedbacks', async (ctx) => {
    if (ctx.chat.type !== 'private' || !ctx.from) {
      await ctx.reply(t('zh', 'privateOnly'));
      return;
    }
    const rows = await myTickets(db, ctx.from.id);
    await safeReply(
      ctx,
      rows.length
        ? rows
            .map(
              (row) =>
                `${row.id}\n${row.status} · ${row.createdAt.toISOString()} · ${row._count.replies} replies`,
            )
            .join('\n\n')
        : t(await lang(ctx), 'feedbackListEmpty'),
    );
  });
  bot.command('ticket', async (ctx) => {
    if (!(await authorized(ctx))) return;
    const id = ctx.match.trim();
    if (!validTicketId(id)) {
      await ctx.reply('/ticket <feedbackId>');
      return;
    }
    const ticket = await getTicket(db, id);
    if (!ticket) {
      await ctx.reply(t(await lang(ctx), 'ticketMissing'));
      return;
    }
    const replies = ticket.replies
      .map((reply) => `${reply.id} [${reply.deliveryStatus}] ${reply.text}`)
      .join('\n');
    await safeReply(
      ctx,
      `${ticket.id} [${ticket.status}]\nAssigned: ${ticket.assignedTo ?? '-'}\nDelivery: ${ticket.deliveryStatus}; attempts=${ticket.deliveryAttempts}; error=${ticket.lastDeliveryErrorCode ?? '-'}\nLast error: ${ticket.lastDeliveryErrorAt?.toISOString() ?? '-'}\n\n${ticket.text}\n\nReplies:\n${replies}\n\nHistory: ${ticket.events.map((event) => event.action).join(', ')}`,
    );
  });
  for (const command of ['assign', 'resolve', 'close', 'reopen'] as const) {
    bot.command(command, async (ctx) => {
      if (!(await authorized(ctx))) return;
      const id = ctx.match.trim();
      if (!validTicketId(id)) {
        await ctx.reply(`/${command} <feedbackId>`);
        return;
      }
      const action =
        command === 'assign'
          ? 'assign'
          : command === 'resolve'
            ? 'resolved'
            : command === 'close'
              ? 'closed'
              : 'open';
      const result = await changeTicket(db, ctx.from!.id, ctx.update.update_id, id, action);
      await ctx.reply(t(await lang(ctx), result === 'saved' ? 'ticketUpdated' : 'ticketMissing'));
    });
  }
  bot.command('reply', async (ctx) => {
    if (!(await authorized(ctx))) return;
    const match = /^(\S+)\s+([\s\S]+)$/.exec(ctx.match.trim());
    const validation = match?.[2] ? validateFeedback(match[2]) : undefined;
    if (!match?.[1] || !validTicketId(match[1]) || !validation?.ok) {
      await ctx.reply(t(await lang(ctx), 'replyUsage'));
      return;
    }
    const replyId = await queueReply(db, ctx.from!.id, ctx.update.update_id, match[1], validation.text);
    if (['missing', 'closed', 'stale'].includes(replyId)) {
      await ctx.reply(t(await lang(ctx), replyId === 'closed' ? 'ticketClosed' : 'ticketMissing'));
      return;
    }
    try {
      await notifications?.enqueueReply(replyId);
    } catch (error) {
      logger.warn({ err: error }, 'Reply persisted; dispatcher will recover');
      reportError(error);
    }
    await ctx.reply(`${t(await lang(ctx), 'replyQueued')}\nID: ${replyId}`);
  });
  bot.command('delivery', async (ctx) => {
    if (!(await authorized(ctx))) return;
    const [kind, id, action] = ctx.match.trim().split(/\s+/);
    if (
      !id ||
      !validTicketId(id) ||
      (kind !== 'feedback' && kind !== 'reply') ||
      !DELIVERY_ACTIONS.includes(action as DeliveryAction)
    ) {
      await ctx.reply('/delivery feedback|reply <id> retry|pause|dismiss');
      return;
    }
    const result = await controlDelivery(
      db,
      ctx.from!.id,
      ctx.update.update_id,
      id,
      action as DeliveryAction,
      kind,
    );
    await ctx.reply(t(await lang(ctx), 'deliveryResult', { result }));
  });
  bot.command('deliveries', async (ctx) => {
    if (!(await authorized(ctx))) return;
    const where = { deliveryStatus: { in: ['blocked', 'paused'] } };
    const [feedback, replies] = await Promise.all([
      db.feedback.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        take: 10,
        select: { id: true, deliveryStatus: true, lastDeliveryErrorCode: true, deliveryAttempts: true },
      }),
      db.feedbackReply.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        take: 10,
        select: {
          id: true,
          feedbackId: true,
          deliveryStatus: true,
          lastDeliveryErrorCode: true,
          deliveryAttempts: true,
        },
      }),
    ]);
    const lines = [
      ...feedback.map(
        (row) =>
          `feedback ${row.id}: ${row.deliveryStatus}, error=${row.lastDeliveryErrorCode ?? '-'}, attempts=${row.deliveryAttempts}`,
      ),
      ...replies.map(
        (row) =>
          `reply ${row.id} (${row.feedbackId}): ${row.deliveryStatus}, error=${row.lastDeliveryErrorCode ?? '-'}, attempts=${row.deliveryAttempts}`,
      ),
    ];
    await safeReply(ctx, lines.length ? lines.join('\n') : 'No blocked or paused deliveries.');
  });
  bot.command('set_status', async (ctx) => {
    if (!(await authorized(ctx))) return;
    const [id, status] = ctx.match.trim().split(/\s+/);
    if (!id || !validTicketId(id) || !TICKET_STATUSES.includes(status as TicketStatus)) {
      await ctx.reply('/set_status <feedbackId> open|in_progress|resolved|closed');
      return;
    }
    const result = await changeTicket(
      db,
      ctx.from!.id,
      ctx.update.update_id,
      id,
      status as TicketStatus,
    );
    await ctx.reply(t(await lang(ctx), result === 'saved' ? 'ticketUpdated' : 'ticketMissing'));
  });
}
