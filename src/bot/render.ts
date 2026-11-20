import { summarizeFeedback } from '../domain/feedback.ts';
import { ticketStatusLabel, type Language, type Translator } from '../domain/i18n.ts';
import type { TicketStatus } from '../generated/prisma/client.ts';

/** Compact UTC timestamp for chat output: 2026-11-20 08:15. */
export function shortTime(date: Date): string {
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

export function contentSummary(
  t: Translator,
  message: { text: string | null; attachmentType: string | null },
  maxLength = 200,
): string {
  const attachment = message.attachmentType
    ? t('attachmentLabel', { type: message.attachmentType })
    : '';
  const text = message.text ? summarizeFeedback(message.text, maxLength) : '';
  return [attachment, text].filter(Boolean).join(' ') || '…';
}

export function messageLines(
  t: Translator,
  messages: readonly {
    direction: string;
    createdAt: Date;
    text: string | null;
    attachmentType: string | null;
  }[],
): string {
  // Callers fetch newest first; show the conversation in reading order.
  return [...messages]
    .reverse()
    .map((m) =>
      t(m.direction === 'inbound' ? 'messageRowIn' : 'messageRowOut', {
        time: shortTime(m.createdAt),
        text: contentSummary(t, m),
      }),
    )
    .join('\n');
}

export function statusText(language: Language, status: TicketStatus): string {
  return ticketStatusLabel(language, status);
}
