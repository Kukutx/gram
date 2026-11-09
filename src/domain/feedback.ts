export const FEEDBACK_MAX_LENGTH = 2000;
export const FEEDBACK_TTL_MS = 15 * 60 * 1000;

export type FeedbackValidation =
  { ok: true; text: string } | { ok: false; reason: 'empty' | 'too_long' | 'command' };

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
