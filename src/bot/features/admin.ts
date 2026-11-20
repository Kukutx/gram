import { Composer, type CommandContext } from 'grammy';
import { countStats, listFeedback } from '../../db/repository.ts';
import {
  changeTicket,
  controlDelivery,
  DELIVERY_ACTIONS,
  getTicket,
  listDeliveryProblems,
  queueReply,
  TICKET_STATUSES,
  validTicketId,
  type DeliveryAction,
  type TicketStatus,
} from '../../db/tickets.ts';
import { summarizeFeedback, validateFeedback } from '../../domain/feedback.ts';
import { deliveryStatusLabel, ticketStatusLabel } from '../../domain/i18n.ts';
import { truncateTelegramText } from '../../domain/telegram-text.ts';
import { reportError } from '../../observability/errors.ts';
import { operationsHealth } from '../../observability/operations.ts';
import type { BotContext, BotDeps } from '../context.ts';

type AdminHandler = (ctx: CommandContext<BotContext> & { from: { id: number } }) => Promise<unknown>;

const STATUS_COMMANDS = {
  assign: 'assign',
  resolve: 'resolved',
  close: 'closed',
  reopen: 'open',
} as const satisfies Record<string, TicketStatus | 'assign'>;

/** Operator commands. Every handler is reachable only by a configured admin in a private chat. */
export function adminFeature({ config, db, notifications, logger }: BotDeps): Composer<BotContext> {
  const composer = new Composer<BotContext>();
  const admin = (command: string, handler: AdminHandler) =>
    composer.command(command, async (ctx) => {
      if (!ctx.isAdmin || !ctx.from) return ctx.reply(ctx.t('forbidden'));
      return handler(ctx as Parameters<AdminHandler>[0]);
    });
  const send = (ctx: BotContext, text: string) =>
    ctx.reply(truncateTelegramText(text, 4096), { link_preview_options: { is_disabled: true } });

  admin('stats', async (ctx) => send(ctx, ctx.t('stats', await countStats(db))));

  admin('status', async (ctx) => {
    const [health, queueReady] = await Promise.all([
      operationsHealth(db, config),
      notifications?.isReady(),
    ]);
    const flag = (value: boolean) => ctx.t(value ? 'yes' : 'no');
    await send(
      ctx,
      ctx.t('status', {
        pending: health.pending + health.pendingReplies,
        health: health.status,
        oldestSeconds: health.oldestPendingAgeSeconds ?? '-',
        queue: notifications ? (queueReady ? 'redis: online' : 'redis: unavailable') : 'postgresql',
        worker: flag(health.workerFresh),
        dispatch: flag(health.dispatchFresh),
        retention: flag(health.retentionFresh),
        blocked: health.blocked + health.blockedReplies,
      }),
    );
  });

  admin('feedbacks', async (ctx) => {
    const rows = await listFeedback(db);
    if (rows.length === 0) return ctx.reply(ctx.t('feedbackListEmpty'));
    const lines = rows.map((item, index) => {
      const author = item.user.username ? `@${item.user.username}` : String(item.user.telegramId);
      const status = ticketStatusLabel(ctx.lang, item.status);
      return `${index + 1}. ${item.id} [${status}]\n${item.createdAt.toISOString()} • ${author}\n${summarizeFeedback(item.text)}`;
    });
    await send(ctx, `${ctx.t('feedbackListTitle')}\n\n${lines.join('\n\n')}`);
  });

  admin('ticket', async (ctx) => {
    const id = ctx.match.trim();
    if (!validTicketId(id)) return ctx.reply(ctx.t('ticketUsage'));
    const ticket = await getTicket(db, id);
    if (!ticket) return ctx.reply(ctx.t('ticketMissing'));
    const none = ctx.t('none');
    const replies = ticket.replies
      .map((reply) =>
        ctx.t('ticketReplyRow', {
          id: reply.id,
          delivery: deliveryStatusLabel(ctx.lang, reply.deliveryStatus),
          text: summarizeFeedback(reply.text, 200),
        }),
      )
      .join('\n');
    await send(
      ctx,
      ctx.t('ticketDetail', {
        id: ticket.id,
        status: ticketStatusLabel(ctx.lang, ticket.status),
        assignee: ticket.assignedTo ?? none,
        delivery: deliveryStatusLabel(ctx.lang, ticket.deliveryStatus),
        attempts: ticket.deliveryAttempts,
        errorCode: ticket.lastDeliveryErrorCode ?? none,
        errorAt: ticket.lastDeliveryErrorAt?.toISOString() ?? none,
        text: ticket.text,
        replies: replies || none,
        history: ticket.events.map((event) => event.action).join(', ') || none,
      }),
    );
  });

  for (const [command, action] of Object.entries(STATUS_COMMANDS)) {
    admin(command, async (ctx) => {
      const id = ctx.match.trim();
      if (!validTicketId(id)) return ctx.reply(ctx.t('ticketCommandUsage', { command }));
      const result = await changeTicket(db, ctx.from.id, ctx.update.update_id, id, action);
      await ctx.reply(ctx.t(result === 'saved' ? 'ticketUpdated' : 'ticketMissing'));
    });
  }

  admin('set_status', async (ctx) => {
    const [id, status] = ctx.match.trim().split(/\s+/);
    if (!id || !validTicketId(id) || !TICKET_STATUSES.includes(status as TicketStatus))
      return ctx.reply(ctx.t('setStatusUsage'));
    const result = await changeTicket(db, ctx.from.id, ctx.update.update_id, id, status as TicketStatus);
    await ctx.reply(ctx.t(result === 'saved' ? 'ticketUpdated' : 'ticketMissing'));
  });

  admin('reply', async (ctx) => {
    const match = /^(\S+)\s+([\s\S]+)$/.exec(ctx.match.trim());
    const validation = match?.[2] ? validateFeedback(match[2]) : undefined;
    if (!match?.[1] || !validTicketId(match[1]) || !validation?.ok)
      return ctx.reply(ctx.t('replyUsage'));
    const result = await queueReply(db, ctx.from.id, ctx.update.update_id, match[1], validation.text);
    if (result === 'missing' || result === 'stale') return ctx.reply(ctx.t('ticketMissing'));
    if (result === 'closed') return ctx.reply(ctx.t('ticketClosed'));
    try {
      await notifications?.enqueueReply(result);
    } catch (error) {
      logger.warn({ err: error }, 'Reply persisted; dispatcher will recover');
      reportError(error);
    }
    await ctx.reply(ctx.t('replyQueued', { id: result }));
  });

  admin('deliveries', async (ctx) => {
    const { feedback, replies } = await listDeliveryProblems(db);
    const none = ctx.t('none');
    const lines = [
      ...feedback.map((row) => ({ ...row, kind: 'feedback', parent: '' })),
      ...replies.map((row) => ({ ...row, kind: 'reply', parent: ` (${row.feedbackId})` })),
    ].map((row) =>
      ctx.t('deliveryRow', {
        kind: row.kind,
        id: row.id,
        parent: row.parent,
        delivery: deliveryStatusLabel(ctx.lang, row.deliveryStatus),
        errorCode: row.lastDeliveryErrorCode ?? none,
        attempts: row.deliveryAttempts,
      }),
    );
    await send(ctx, lines.length ? lines.join('\n') : ctx.t('deliveriesEmpty'));
  });

  admin('delivery', async (ctx) => {
    const [kind, id, action] = ctx.match.trim().split(/\s+/);
    if (
      !id ||
      !validTicketId(id) ||
      (kind !== 'feedback' && kind !== 'reply') ||
      !DELIVERY_ACTIONS.includes(action as DeliveryAction)
    )
      return ctx.reply(ctx.t('deliveryUsage'));
    const result = await controlDelivery(
      db,
      ctx.from.id,
      ctx.update.update_id,
      id,
      action as DeliveryAction,
      kind,
    );
    await ctx.reply(ctx.t('deliveryResult', { result }));
  });

  return composer;
}
