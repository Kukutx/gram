import { GrammyError, InlineKeyboard, type Api } from 'grammy';
import type { AbortSignal } from 'abort-controller';
import type { AppConfig } from '../config/env.ts';
import type { Database } from '../db/client.ts';
import {
  loadDelivery,
  markFailed,
  markSent,
  releaseDelivery,
  setTicketThread,
  type LoadedDelivery,
} from '../db/outbox.ts';
import { CAPTIONED_TYPES, isAttachmentType, type AttachmentType } from '../domain/content.ts';
import { normalizeLanguage, t, ticketStatusLabel, type Language } from '../domain/i18n.ts';
import type { StatusAction } from '../db/tickets.ts';
import type { TicketStatus } from '../generated/prisma/client.ts';
import {
  TELEGRAM_CAPTION_MAX_UNITS,
  truncateTelegramText,
  withHeader,
} from '../domain/telegram-text.ts';
import { reportError } from '../observability/errors.ts';
import { safeError, type Logger } from '../observability/logger.ts';

export type SenderDeps = { db: Database; api: Api; config: AppConfig; logger: Logger };
export type SendOutcome = 'sent' | 'retry' | 'blocked' | 'gone' | 'lost_lease';

/** Telegram rejects these for good: bad request, revoked token, bot blocked by the user. */
const PERMANENT_ERROR_CODES = new Set([400, 401, 403]);

type Other = Record<string, unknown>;
type MediaSender = (
  api: Api,
  chatId: number,
  fileId: string,
  other: Other,
  signal?: AbortSignal,
) => Promise<{ message_id: number }>;

// grammY's per-method option types differ; the shared subset used here is valid for all of them.
const MEDIA: Record<AttachmentType, MediaSender> = {
  photo: (api, chat, file, other, signal) => api.sendPhoto(chat, file, other, signal),
  document: (api, chat, file, other, signal) => api.sendDocument(chat, file, other, signal),
  video: (api, chat, file, other, signal) => api.sendVideo(chat, file, other, signal),
  audio: (api, chat, file, other, signal) => api.sendAudio(chat, file, other, signal),
  voice: (api, chat, file, other, signal) => api.sendVoice(chat, file, other, signal),
  animation: (api, chat, file, other, signal) => api.sendAnimation(chat, file, other, signal),
  sticker: (api, chat, file, other, signal) => api.sendSticker(chat, file, other, signal),
  video_note: (api, chat, file, other, signal) => api.sendVideoNote(chat, file, other, signal),
};

export function authorLabel(user: {
  username: string | null;
  firstName: string | null;
  telegramId: bigint;
}): string {
  if (user.username) return `@${user.username}`;
  return user.firstName ? `${user.firstName} (${user.telegramId})` : String(user.telegramId);
}

const TICKET_BUTTONS = {
  open: ['assign', 'resolved', 'closed'],
  in_progress: ['resolved', 'closed'],
  resolved: ['closed', 'open'],
  closed: ['open'],
} as const satisfies Record<TicketStatus, readonly StatusAction[]>;
const BUTTON_LABELS = {
  assign: 'btnTake',
  resolved: 'btnResolve',
  closed: 'btnClose',
  open: 'btnReopen',
} as const;

/** Whether a ticket in `status` shows the button for `action`. */
export function offersAction(status: TicketStatus, action: StatusAction): boolean {
  return (TICKET_BUTTONS[status] as readonly StatusAction[] | undefined)?.includes(action) ?? false;
}

/**
 * Buttons on admin notifications, handled by the bot's support feature. They offer only
 * the next sensible steps for the ticket's status; a press refreshes them.
 */
export function ticketKeyboard(
  language: Language,
  number: number,
  status: TicketStatus,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const action of TICKET_BUTTONS[status] ?? TICKET_BUTTONS.open)
    keyboard.text(t(language, BUTTON_LABELS[action]), `tk:${number}:${action}`);
  return keyboard;
}

type Plan = {
  chatId: number;
  language: Language;
  header: string;
  keyboard?: InlineKeyboard;
  toAdminGroup: boolean;
};

function plan(delivery: LoadedDelivery, config: AppConfig): Plan {
  const { message } = delivery;
  const { ticket } = message;
  const chatId = Number(delivery.chatId);
  if (message.direction === 'outbound') {
    const language = normalizeLanguage(ticket.user.language, config.DEFAULT_LANGUAGE);
    // System notices (authorId 0) are already complete, localized sentences.
    const header = message.authorId === 0n ? '' : t(language, 'notifyReply', { number: ticket.number });
    return { chatId, language, header, toAdminGroup: false };
  }
  const language = config.DEFAULT_LANGUAGE;
  const first = ticket._count.messages <= 1;
  const header = t(language, first ? 'notifyNewTicket' : 'notifyFollowUp', {
    number: ticket.number,
    author: authorLabel(ticket.user),
    status: ticketStatusLabel(language, ticket.status),
  });
  return {
    chatId,
    language,
    header,
    keyboard: ticketKeyboard(language, ticket.number, ticket.status),
    toAdminGroup: config.ADMIN_CHAT_ID !== undefined && chatId === config.ADMIN_CHAT_ID,
  };
}

async function ensureTopic(
  deps: SenderDeps,
  delivery: LoadedDelivery,
  signal?: AbortSignal,
): Promise<number> {
  const { ticket } = delivery.message;
  if (ticket.adminThreadId !== null) return ticket.adminThreadId;
  const name = truncateTelegramText(`#${ticket.number} ${authorLabel(ticket.user)}`, 128);
  const topic = await deps.api.createForumTopic(Number(delivery.chatId), name, {}, signal);
  await setTicketThread(deps.db, ticket.id, topic.message_thread_id);
  return topic.message_thread_id;
}

async function transmit(
  deps: SenderDeps,
  delivery: LoadedDelivery,
  p: Plan,
  signal?: AbortSignal,
): Promise<{ messageId: number; headerMessageId?: number; threadId?: number }> {
  const { message } = delivery;
  const threadId =
    p.toAdminGroup && deps.config.ADMIN_USE_TOPICS
      ? await ensureTopic(deps, delivery, signal)
      : undefined;
  const base: Other = {
    ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
    ...(p.keyboard ? { reply_markup: p.keyboard } : {}),
  };
  const text = message.text ?? '';
  const type = message.attachmentType;
  if (!type || !message.attachmentId || !isAttachmentType(type)) {
    const sent = await deps.api.sendMessage(
      p.chatId,
      withHeader(p.header, text) || '…',
      { ...base, link_preview_options: { is_disabled: true } },
      signal,
    );
    return { messageId: sent.message_id, threadId };
  }
  if (CAPTIONED_TYPES.has(type)) {
    const caption = truncateTelegramText(p.header + text, TELEGRAM_CAPTION_MAX_UNITS);
    const sent = await MEDIA[type](
      deps.api,
      p.chatId,
      message.attachmentId,
      { ...base, ...(caption ? { caption } : {}) },
      signal,
    );
    return { messageId: sent.message_id, threadId };
  }
  // Stickers and round videos take no caption: send the header first, then the media as its reply.
  let headerMessageId: number | undefined;
  if (p.header.trim()) {
    const header = await deps.api.sendMessage(p.chatId, p.header.trim(), base, signal);
    headerMessageId = header.message_id;
  }
  const media = await MEDIA[type](
    deps.api,
    p.chatId,
    message.attachmentId,
    {
      ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
      ...(headerMessageId
        ? { reply_parameters: { message_id: headerMessageId, allow_sending_without_reply: true } }
        : {}),
    },
    signal,
  );
  return { messageId: media.message_id, headerMessageId, threadId };
}

/**
 * Sends one leased delivery and records the outcome. Never throws for Telegram
 * errors: the outbox row carries the retry schedule instead.
 */
export async function sendDelivery(
  deps: SenderDeps,
  id: string,
  token: string,
  signal?: AbortSignal,
): Promise<SendOutcome> {
  const delivery = await loadDelivery(deps.db, id);
  if (!delivery) return 'gone'; // Erased or expired after the claim.
  if (delivery.leaseToken !== token) return 'lost_lease';
  const p = plan(delivery, deps.config);
  try {
    const sent = await transmit(deps, delivery, p, signal);
    if (!(await markSent(deps.db, id, token, sent))) {
      deps.logger.warn(
        { direction: delivery.message.direction },
        'Delivery lease lost before confirmation',
      );
      return 'lost_lease';
    }
    deps.logger.info({ direction: delivery.message.direction }, 'Message delivered');
    return 'sent';
  } catch (error) {
    if (signal?.aborted) {
      // Shutdown interrupted the request: hand the row back without counting a failure.
      await releaseDelivery(deps.db, id, token);
      return 'retry';
    }
    const safe = safeError(error);
    const code = typeof safe.code === 'number' ? safe.code : null;
    // A deleted forum topic: forget it so the next attempt opens a new one.
    const lostTopic =
      error instanceof GrammyError && code === 400 && /thread not found|topic/i.test(error.description);
    if (lostTopic) await setTicketThread(deps.db, delivery.message.ticket.id, null);
    const permanent = !lostTopic && code !== null && PERMANENT_ERROR_CODES.has(code);
    const retryAfter =
      error instanceof GrammyError && code === 429 ? (error.parameters.retry_after ?? 0) : 0;
    const outcome = await markFailed(deps.db, id, token, {
      code,
      permanent,
      attempts: delivery.attempts,
      retryAfterMs: retryAfter * 1_000,
    });
    deps.logger.error(
      { err: error, direction: delivery.message.direction },
      outcome === 'blocked'
        ? 'Delivery blocked; operator action required'
        : 'Delivery failed; will retry',
    );
    reportError(error);
    return outcome;
  }
}
