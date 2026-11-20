import type { InlineKeyboard } from 'grammy';
import type { Database } from '../db/client.ts';
import { TICKET_STATUSES } from '../db/tickets.ts';
import { authorLabel, ticketKeyboard } from '../delivery/sender.ts';
import {
  interpolate,
  statusLine,
  ticketStatusLabel,
  type Language,
  type TranslationKey,
} from '../domain/i18n.ts';
import type { Prisma, TicketStatus } from '../generated/prisma/client.ts';
import type { BotContext } from './context.ts';
import { restateStatus } from './render.ts';

export type ChangeResult = 'saved' | 'missing' | 'unchanged' | 'stale';

export type TicketState = { number: number; status: TicketStatus; author: string };

/**
 * What an operator sees after a status change, from a command or a button: the outcome
 * with the ticket's current status, and the buttons for the next step.
 */
export async function describeChange(
  ctx: BotContext,
  db: Database,
  where: Prisma.TicketWhereUniqueInput,
  result: ChangeResult,
  buttonLanguage: Language,
): Promise<{ text: string; keyboard?: InlineKeyboard; ticket?: TicketState }> {
  const found =
    result === 'missing'
      ? null
      : await db.ticket.findUnique({
          where,
          select: {
            number: true,
            status: true,
            user: { select: { username: true, firstName: true, telegramId: true } },
          },
        });
  if (!found) return { text: ctx.t('ticketMissing') };
  const ticket = { number: found.number, status: found.status, author: authorLabel(found.user) };
  const variables = { number: ticket.number, status: ticketStatusLabel(ctx.lang, ticket.status) };
  const text =
    result === 'saved'
      ? ctx.t('callbackDone', variables)
      : result === 'unchanged'
        ? ctx.t('ticketUnchanged', variables)
        : ctx.t('alreadyHandled');
  return { text, keyboard: ticketKeyboard(buttonLanguage, ticket.number, ticket.status), ticket };
}

/** Lines of the bot's own ticket messages that state the status, and what each becomes. */
const STATUS_LINES = [
  ['notifyNewTicket', 'notifyNewTicket'],
  ['notifyFollowUp', 'notifyFollowUp'],
  ['ticketDetail', 'ticketDetail'],
  ['callbackDone', 'callbackDone'],
  // "Already resolved, nothing changed" turns into the plain result once a button changes it.
  ['ticketUnchanged', 'callbackDone'],
] as const satisfies readonly (readonly [TranslationKey, TranslationKey])[];

/**
 * A notification, status reply or /ticket message restated with the ticket's current status,
 * so a pressed button leaves no stale status behind. Null when the message shows none of
 * those lines (another language, an edited name) or already shows the current status.
 */
export function restatedMessage(
  text: string,
  languages: readonly Language[],
  ticket: TicketState,
): string | null {
  for (const language of new Set(languages)) {
    const variables = { number: ticket.number, author: ticket.author };
    const lines = STATUS_LINES.flatMap(([from, to]) => {
      const before = statusLine(language, from);
      const after = statusLine(language, to);
      return before && after
        ? [
            {
              index: before.index,
              from: interpolate(before.line, variables),
              to: interpolate(after.line, variables),
            },
          ]
        : [];
    });
    const labels = TICKET_STATUSES.map((status) => ticketStatusLabel(language, status));
    const restated = restateStatus(text, lines, labels, ticketStatusLabel(language, ticket.status));
    if (restated !== null) return restated;
  }
  return null;
}
