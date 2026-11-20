import type { InlineKeyboard } from 'grammy';
import type { Database } from '../db/client.ts';
import { ticketKeyboard } from '../delivery/sender.ts';
import { ticketStatusLabel, type Language } from '../domain/i18n.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import type { BotContext } from './context.ts';

export type ChangeResult = 'saved' | 'missing' | 'unchanged' | 'stale';

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
): Promise<{ text: string; keyboard?: InlineKeyboard }> {
  const ticket =
    result === 'missing'
      ? null
      : await db.ticket.findUnique({ where, select: { number: true, status: true } });
  if (!ticket) return { text: ctx.t('ticketMissing') };
  const variables = { number: ticket.number, status: ticketStatusLabel(ctx.lang, ticket.status) };
  const text =
    result === 'saved'
      ? ctx.t('callbackDone', variables)
      : result === 'unchanged'
        ? ctx.t('ticketUnchanged', variables)
        : ctx.t('alreadyHandled');
  return { text, keyboard: ticketKeyboard(buttonLanguage, ticket.number, ticket.status) };
}
