import { MESSAGE_TEXT_MAX } from './content.ts';

export const FEEDBACK_MAX_LENGTH = MESSAGE_TEXT_MAX;
export const FEEDBACK_TTL_MS = 15 * 60 * 1000;

export type FeedbackValidation =
  { ok: true; text: string } | { ok: false; reason: 'empty' | 'too_long' | 'command' };

/** Validates free text typed after an admin command such as /reply. */
export function validateFeedback(raw: string): FeedbackValidation {
  const text = raw.trim();
  if (text.length === 0) return { ok: false, reason: 'empty' };
  if (text.startsWith('/')) return { ok: false, reason: 'command' };
  if ([...text].length > FEEDBACK_MAX_LENGTH) return { ok: false, reason: 'too_long' };
  return { ok: true, text };
}

export function expiresInFifteenMinutes(now: Date = new Date()): Date {
  return new Date(now.getTime() + FEEDBACK_TTL_MS);
}

export function summarizeFeedback(text: string, maxLength = 280): string {
  const characters = [...text];
  return characters.length > maxLength ? `${characters.slice(0, maxLength - 1).join('')}…` : text;
}

/** Accepts `#12`, `12` or a ticket's cuid. */
export function parseTicketRef(raw: string): { number: number } | { id: string } | null {
  const value = raw.trim();
  const numeric = /^#?(\d{1,9})$/.exec(value);
  if (numeric) return { number: Number(numeric[1]) };
  return /^[A-Za-z0-9_-]{8,64}$/.test(value) ? { id: value } : null;
}
