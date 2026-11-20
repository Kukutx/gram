import { Composer, InlineKeyboard } from 'grammy';
import { setBanned } from '../../db/users.ts';
import {
  addStaffMessage,
  changeTicket,
  controlDelivery,
  countStats,
  DELIVERY_ACTIONS,
  getTicket,
  listDeliveryProblems,
  listTickets,
  searchTickets,
  TICKET_PAGE_SIZE,
  TICKET_STATUSES,
  ticketOwner,
  ticketWhere,
  type DeliveryAction,
  type StatusAction,
} from '../../db/tickets.ts';
import { authorLabel } from '../../delivery/sender.ts';
import { validateFeedback } from '../../domain/feedback.ts';
import { deliveryStatusLabel, outboxHealthLabel, ticketStatusLabel } from '../../domain/i18n.ts';
import { truncateTelegramText } from '../../domain/telegram-text.ts';
import type { TicketStatus } from '../../generated/prisma/client.ts';
import { operationsHealth } from '../../observability/operations.ts';
import type { BotContext, BotDeps } from '../context.ts';
import { statusNotice } from '../recipients.ts';
import { contentSummary, messageLines, shortTime } from '../render.ts';
import { resolveTicketRef } from '../ticket-ref.ts';

type ListFilter = TicketStatus | 'active' | 'all';
const LIST_FILTERS: readonly ListFilter[] = ['active', 'all', ...TICKET_STATUSES];

const STATUS_COMMANDS = {
  assign: 'assign',
  resolve: 'resolved',
  close: 'closed',
  reopen: 'open',
} as const satisfies Record<string, StatusAction>;

const CHANGE_REPLIES = {
  saved: 'ticketUpdated',
  missing: 'ticketMissing',
  unchanged: 'ticketUnchanged',
  stale: 'alreadyHandled',
} as const;

type AdminContext = BotContext & { from: NonNullable<BotContext['from']>; match: string };

function isListFilter(value: string): value is ListFilter {
  return (LIST_FILTERS as readonly string[]).includes(value);
}

/**
 * Operator commands. They work in an admin's private chat and anywhere in the
 * support group; inside a ticket's forum topic (or when replying to a ticket
 * notification) the ticket number may be omitted.
 */
export function adminFeature({ config, db }: BotDeps): Composer<BotContext> {
  const composer = new Composer<BotContext>();
  const notice = statusNotice(config);
  const send = (ctx: BotContext, text: string, keyboard?: InlineKeyboard) =>
    ctx.reply(truncateTelegramText(text, 4096), {
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });

  /** Registers an admin command. `userFallback` lets the user-side feature answer non-admins. */
  const admin = (
    command: string,
    handler: (ctx: AdminContext) => Promise<unknown>,
    { userFallback = false } = {},
  ) =>
    composer.command(command, async (ctx, next) => {
      if (ctx.isAdmin && ctx.from) return handler(ctx as AdminContext);
      if (userFallback) return next();
      // Stay quiet in unrelated groups; only answer people talking to the bot directly.
      if (ctx.chat.type === 'private') return ctx.reply(ctx.t('forbidden'));
    });

  /** The ticket a command targets: explicit argument first, then reply/topic context. */
  const target = (ctx: AdminContext, arg: string) => resolveTicketRef(ctx, db, arg);

  async function renderList(ctx: BotContext, filter: ListFilter, page: number) {
    const { total, rows } = await listTickets(db, {
      status: filter === 'all' ? undefined : filter,
      offset: (page - 1) * TICKET_PAGE_SIZE,
    });
    if (total === 0) return { text: ctx.t('ticketListEmpty'), keyboard: undefined };
    const pages = Math.max(1, Math.ceil(total / TICKET_PAGE_SIZE));
    const label =
      filter === 'all'
        ? ctx.t('filterAll')
        : filter === 'active'
          ? ctx.t('filterActive')
          : ticketStatusLabel(ctx.lang, filter);
    const lines = rows.map((row) =>
      ctx.t('ticketListRow', {
        number: row.number,
        status: ticketStatusLabel(ctx.lang, row.status),
        author: authorLabel(row.user),
        time: shortTime(row.lastMessageAt, config.TIME_ZONE),
        summary: row.messages[0] ? contentSummary(ctx.t, row.messages[0], 120) : '…',
      }),
    );
    const keyboard = new InlineKeyboard();
    if (page > 1) keyboard.text(ctx.t('btnPrev'), `tl:${filter}:${page - 1}`);
    if (page < pages) keyboard.text(ctx.t('btnNext'), `tl:${filter}:${page + 1}`);
    return {
      text: `${ctx.t('ticketListTitle', { filter: label, page, pages, total })}\n\n${lines.join('\n\n')}`,
      keyboard: page > 1 || page < pages ? keyboard : undefined,
    };
  }

  const listCommand = async (ctx: AdminContext) => {
    const [rawFilter = 'active', rawPage = '1'] = ctx.match.trim().split(/\s+/).filter(Boolean);
    const filter = isListFilter(rawFilter) ? rawFilter : 'active';
    const page = Math.max(1, Number.parseInt(rawPage, 10) || 1);
    const { text, keyboard } = await renderList(ctx, filter, page);
    return send(ctx, text, keyboard);
  };
  admin('tickets', listCommand);
  admin('feedbacks', listCommand); // v1 name

  composer.callbackQuery(/^tl:([a-z_]+):(\d{1,6})$/, async (ctx) => {
    if (!ctx.isAdmin) return ctx.answerCallbackQuery({ text: ctx.t('forbidden') });
    const [, rawFilter = 'active', rawPage = '1'] = ctx.match;
    const filter = isListFilter(rawFilter) ? rawFilter : 'active';
    const { text, keyboard } = await renderList(ctx, filter, Math.max(1, Number(rawPage)));
    await ctx.answerCallbackQuery();
    await ctx
      .editMessageText(truncateTelegramText(text, 4096), {
        link_preview_options: { is_disabled: true },
        ...(keyboard ? { reply_markup: keyboard } : {}),
      })
      .catch(() => undefined); // "message is not modified" after a double tap
  });

  admin(
    'ticket',
    async (ctx) => {
      const where = await target(ctx, ctx.match);
      if (!where) return ctx.reply(ctx.t('ticketUsage'));
      const ticket = await getTicket(db, where, 15);
      if (!ticket) return ctx.reply(ctx.t('ticketMissing'));
      const none = ctx.t('none');
      await send(
        ctx,
        ctx.t('ticketDetail', {
          number: ticket.number,
          status: ticketStatusLabel(ctx.lang, ticket.status),
          author: authorLabel(ticket.user),
          banned: ticket.user.bannedAt ? ctx.t('bannedMark') : '',
          assignee: ticket.assignedTo?.toString() ?? none,
          count: ticket._count.messages,
          shown: ticket.messages.length,
          messages: messageLines(ctx.t, ticket.messages, config.TIME_ZONE) || none,
          history:
            ticket.events
              .map((e) => `${e.action}@${shortTime(e.createdAt, config.TIME_ZONE)}`)
              .join(', ') || none,
        }),
      );
    },
    { userFallback: true },
  );

  admin('search', async (ctx) => {
    const query = ctx.match.trim();
    if (query.length < 2) return ctx.reply(ctx.t('searchUsage'));
    const rows = await searchTickets(db, query.slice(0, 100));
    if (!rows.length) return ctx.reply(ctx.t('searchEmpty'));
    const lines = rows.map(
      (row) =>
        `#${row.number} [${ticketStatusLabel(ctx.lang, row.status)}] ${shortTime(row.lastMessageAt, config.TIME_ZONE)}`,
    );
    await send(ctx, `${ctx.t('searchTitle', { query: query.slice(0, 100) })}\n${lines.join('\n')}`);
  });

  admin('reply', async (ctx) => {
    const raw = ctx.match.trim();
    // `/reply 12 text` names the ticket; inside a topic or a reply, `/reply text` is enough.
    const explicit = /^(#?\d{1,9})\s+([\s\S]+)$/.exec(raw);
    const where = explicit ? ticketWhere(explicit[1]!) : await target(ctx, '');
    const validation = validateFeedback(explicit ? explicit[2]! : raw);
    if (!where || !validation.ok) return ctx.reply(ctx.t('replyUsage'));
    const result = await addStaffMessage(db, ctx.from.id, ctx.update.update_id, where, {
      text: validation.text,
      attachment: null,
    });
    if (result.kind === 'missing') return ctx.reply(ctx.t('ticketMissing'));
    if (result.kind === 'closed') return ctx.reply(ctx.t('ticketClosed'));
    await ctx.reply(ctx.t('replyQueued', { number: result.number }));
  });

  for (const [command, action] of Object.entries(STATUS_COMMANDS)) {
    admin(command, async (ctx) => {
      const where = await target(ctx, ctx.match);
      if (!where) return ctx.reply(ctx.t('ticketCommandUsage', { command }));
      const result = await changeTicket(db, ctx.from.id, ctx.update.update_id, where, action, notice);
      await ctx.reply(ctx.t(CHANGE_REPLIES[result]));
    });
  }

  admin('set_status', async (ctx) => {
    const parts = ctx.match.trim().split(/\s+/).filter(Boolean);
    const status = parts.pop();
    if (!status || !TICKET_STATUSES.includes(status as TicketStatus))
      return ctx.reply(ctx.t('setStatusUsage'));
    const where = await target(ctx, parts.join(' '));
    if (!where) return ctx.reply(ctx.t('setStatusUsage'));
    const result = await changeTicket(
      db,
      ctx.from.id,
      ctx.update.update_id,
      where,
      status as TicketStatus,
      notice,
    );
    await ctx.reply(ctx.t(CHANGE_REPLIES[result]));
  });

  /** `#12` means "the owner of ticket 12"; bare digits are a Telegram user ID. */
  async function banTarget(ctx: AdminContext): Promise<number | null> {
    const arg = ctx.match.trim();
    if (/^\d{1,16}$/.test(arg)) return Number(arg);
    const where = await target(ctx, arg);
    return where ? ticketOwner(db, where) : null;
  }

  for (const [command, banned] of [
    ['ban', true],
    ['unban', false],
  ] as const) {
    admin(command, async (ctx) => {
      const userId = await banTarget(ctx);
      if (userId === null || !Number.isSafeInteger(userId)) return ctx.reply(ctx.t('banUsage'));
      if (banned && config.ADMIN_IDS.includes(userId)) return ctx.reply(ctx.t('forbidden'));
      const saved = await setBanned(db, userId, banned);
      await ctx.reply(ctx.t(saved ? (banned ? 'banned' : 'unbanned') : 'userMissing'));
    });
  }

  admin('deliveries', async (ctx) => {
    const rows = await listDeliveryProblems(db);
    if (!rows.length) return ctx.reply(ctx.t('deliveriesEmpty'));
    const none = ctx.t('none');
    const lines = rows.map((row) =>
      ctx.t('deliveryRow', {
        id: row.id,
        number: row.message.ticket.number,
        direction: ctx.t(row.message.direction === 'inbound' ? 'directionIn' : 'directionOut'),
        chat: row.chatId,
        delivery: deliveryStatusLabel(ctx.lang, row.status),
        errorCode: row.lastErrorCode ?? none,
        attempts: row.attempts,
      }),
    );
    await send(ctx, lines.join('\n'));
  });

  admin('delivery', async (ctx) => {
    const [id, action] = ctx.match.trim().split(/\s+/);
    if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id) || !DELIVERY_ACTIONS.includes(action as DeliveryAction))
      return ctx.reply(ctx.t('deliveryUsage'));
    const result = await controlDelivery(
      db,
      ctx.from.id,
      ctx.update.update_id,
      id,
      action as DeliveryAction,
    );
    await ctx.reply(ctx.t('deliveryResult', { result }));
  });

  admin('stats', async (ctx) => {
    const { users, banned, tickets, pending } = await countStats(db);
    await send(
      ctx,
      ctx.t('stats', {
        users,
        banned,
        open: tickets.open,
        inProgress: tickets.in_progress,
        resolved: tickets.resolved,
        closed: tickets.closed,
        pending,
      }),
    );
  });

  admin('status', async (ctx) => {
    const health = await operationsHealth(db, config);
    const flag = (value: boolean) => ctx.t(value ? 'yes' : 'no');
    await send(
      ctx,
      ctx.t('status', {
        pending: health.pending,
        health: outboxHealthLabel(ctx.lang, health.status),
        oldest:
          health.oldestPendingAgeSeconds === null
            ? ctx.t('none')
            : ctx.t('secondsAgo', { seconds: health.oldestPendingAgeSeconds }),
        blocked: health.blocked,
        worker: flag(health.workerFresh),
        dispatch: flag(health.dispatchFresh),
        retention: flag(health.retentionFresh),
      }),
    );
  });

  return composer;
}
