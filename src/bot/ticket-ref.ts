import type { Database } from '../db/client.ts';
import { ticketForDeliveredMessage, ticketForThread, ticketWhere } from '../db/tickets.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import type { BotContext } from './context.ts';

/**
 * Finds the ticket an operator means: an explicit `#12`/`12`/ID argument, else the
 * notification they replied to, else the forum topic they are typing in.
 */
export async function resolveTicketRef(
  ctx: BotContext,
  db: Database,
  arg: string,
): Promise<Prisma.TicketWhereUniqueInput | null> {
  if (arg.trim()) return ticketWhere(arg);
  const message = ctx.message;
  if (!message || !ctx.chat) return null;
  const replyTo = message.reply_to_message;
  // In forum topics every message "replies" to the topic's root; ignore that implicit reply.
  if (replyTo && !(message.is_topic_message && replyTo.message_id === message.message_thread_id)) {
    const ticket = await ticketForDeliveredMessage(db, ctx.chat.id, replyTo.message_id);
    if (ticket) return { id: ticket.id };
  }
  if (ctx.inSupportChat && message.is_topic_message && message.message_thread_id !== undefined) {
    const ticket = await ticketForThread(db, message.message_thread_id);
    if (ticket) return { id: ticket.id };
  }
  return null;
}
