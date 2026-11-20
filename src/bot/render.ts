import { summarizeFeedback } from '../domain/feedback.ts';
import { ticketStatusLabel, type Language, type Translator } from '../domain/i18n.ts';
import type { TicketStatus } from '../generated/prisma/client.ts';

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Compact timestamp for chat output in the configured IANA time zone: 2026-11-20 08:15. */
export function shortTime(date: Date, timeZone = 'UTC'): string {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, format);
  }
  const part = Object.fromEntries(format.formatToParts(date).map((p) => [p.type, p.value]));
  return `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}`;
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
  timeZone = 'UTC',
): string {
  // Callers fetch newest first; show the conversation in reading order.
  return [...messages]
    .reverse()
    .map((m) =>
      t(m.direction === 'inbound' ? 'messageRowIn' : 'messageRowOut', {
        time: shortTime(m.createdAt, timeZone),
        text: contentSummary(t, m),
      }),
    )
    .join('\n');
}

/** About `width` characters of `text` around the first case-insensitive match of `query`. */
export function snippetAround(text: string, query: string, width = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= width) return flat;
  const at = Math.max(0, flat.toLowerCase().indexOf(query.toLowerCase()));
  const start = Math.max(0, Math.min(at - Math.floor((width - query.length) / 2), flat.length - width));
  const end = Math.min(flat.length, start + width);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`;
}

/** Rough, human-friendly length of time: "5 分钟", "3 小时 12 分", "2 天 4 小时". */
export function formatDuration(t: Translator, seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return t('durationDays', { days, hours: hours % 24 });
  if (hours > 0) return t('durationHours', { hours, minutes: minutes % 60 });
  return t('durationMinutes', { minutes });
}

export function statusText(language: Language, status: TicketStatus): string {
  return ticketStatusLabel(language, status);
}
