import { en } from './locales/en.ts';
import { zh } from './locales/zh.ts';

/**
 * Adding a language: create `locales/<code>.ts` typed as `Record<TranslationKey, string>`,
 * then register it below. Missing keys fail the type check, not production.
 */
export const LANGUAGES = ['zh', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];
export type TranslationKey = keyof typeof zh;
export type Variables = Record<string, string | number | bigint>;

const dictionaries: Record<Language, Record<TranslationKey, string>> = { zh, en };

export const LANGUAGE_LABELS: Record<Language, string> = { zh: '🇨🇳 简体中文', en: '🇬🇧 English' };

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

/** Maps a Telegram `language_code` (e.g. `en-US`) to a supported language. */
export function normalizeLanguage(code: string | undefined | null, fallback: Language = 'zh'): Language {
  const base = code?.toLowerCase().split(/[-_]/, 1)[0];
  return isLanguage(base) ? base : fallback;
}

export function t(language: Language, key: TranslationKey, variables: Variables = {}): string {
  return dictionaries[language][key].replace(/\{([a-zA-Z]+)\}/g, (whole, name: string) =>
    Object.hasOwn(variables, name) ? String(variables[name]) : whole,
  );
}

export type Translator = (key: TranslationKey, variables?: Variables) => string;

export function translator(language: Language): Translator {
  return (key, variables) => t(language, key, variables);
}

const TICKET_STATUS_KEYS = {
  open: 'statusOpen',
  in_progress: 'statusInProgress',
  resolved: 'statusResolved',
  closed: 'statusClosed',
} as const satisfies Record<string, TranslationKey>;

const DELIVERY_STATUS_KEYS = {
  pending: 'deliveryPending',
  sent: 'deliverySent',
  blocked: 'deliveryBlocked',
  paused: 'deliveryPaused',
  dismissed: 'deliveryDismissed',
} as const satisfies Record<string, TranslationKey>;

/** Unknown stored values are shown verbatim rather than hidden. */
export function ticketStatusLabel(language: Language, status: string): string {
  const key = TICKET_STATUS_KEYS[status as keyof typeof TICKET_STATUS_KEYS];
  return key ? t(language, key) : status;
}

export function deliveryStatusLabel(language: Language, status: string): string {
  const key = DELIVERY_STATUS_KEYS[status as keyof typeof DELIVERY_STATUS_KEYS];
  return key ? t(language, key) : status;
}

const OUTBOX_HEALTH_KEYS = {
  empty: 'healthEmpty',
  pending: 'healthPending',
  warning: 'healthWarning',
  critical: 'healthCritical',
  unknown: 'healthUnknown',
} as const satisfies Record<string, TranslationKey>;

export function outboxHealthLabel(language: Language, status: string): string {
  const key = OUTBOX_HEALTH_KEYS[status as keyof typeof OUTBOX_HEALTH_KEYS];
  return key ? t(language, key) : status;
}

const TICKET_EVENT_KEYS = {
  assign: 'eventAssign',
  reply: 'eventReply',
  reopened_by_user: 'eventReopenedByUser',
  delivery_retry: 'eventDeliveryRetry',
  delivery_pause: 'eventDeliveryPause',
  delivery_dismiss: 'eventDeliveryDismiss',
} as const satisfies Record<string, TranslationKey>;

/** Audit events: a status change reads as the status itself; unknown (legacy) actions verbatim. */
export function ticketEventLabel(language: Language, action: string): string {
  if (Object.hasOwn(TICKET_STATUS_KEYS, action)) return ticketStatusLabel(language, action);
  const key = TICKET_EVENT_KEYS[action as keyof typeof TICKET_EVENT_KEYS];
  return key ? t(language, key) : action;
}
