import { z } from 'zod';
import { LANGUAGES } from '../domain/i18n.ts';

const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;
const optionalTrimmed = z.preprocess(blankToUndefined, z.string().trim().optional());
const isTimeZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};
const booleanFlag = (fallback: boolean) =>
  z.preprocess((value) => {
    const v = blankToUndefined(value);
    if (typeof v !== 'string') return v;
    if (/^(1|true|yes|on)$/i.test(v)) return true;
    if (/^(0|false|no|off)$/i.test(v)) return false;
    return v;
  }, z.boolean().default(fallback));

const tokenSchema = z.string().regex(/^\d{5,16}:[A-Za-z0-9_-]{10,}$/, 'Invalid BotFather token format');
const webhookPathSchema = z
  .string()
  .regex(/^\/[A-Za-z0-9/_-]+$/)
  .default('/telegram/webhook');
const secretTokenPattern = /^[A-Za-z0-9_-]{1,256}$/;

/** Comma/space separated positive Telegram user IDs. */
const idList = z.preprocess(
  (value) => (typeof value === 'string' ? value.split(/[\s,]+/).filter(Boolean) : (value ?? [])),
  z.array(z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)),
);

function httpsUrl(value: string, allowLocalhost = false): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (allowLocalhost && url.hostname === 'localhost');
  } catch {
    return false;
  }
}

const configSchema = z
  .object({
    BOT_TOKEN: tokenSchema,
    BOT_MODE: z.enum(['polling', 'webhook']).default('polling'),
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'Requires a PostgreSQL URL'),
    /** Optional: only used for cross-instance rate limiting. */
    REDIS_URL: optionalTrimmed,

    /** Users allowed to run admin commands; each also gets notifications by private message. */
    ADMIN_IDS: idList,
    /** Deprecated single-admin setting from v1, merged into ADMIN_IDS. */
    ADMIN_TELEGRAM_ID: optionalTrimmed,
    /**
     * Optional support group (negative chat ID). When set, notifications go to this group
     * instead of admin private chats, and every member of it may handle tickets there.
     */
    ADMIN_CHAT_ID: z.preprocess(blankToUndefined, z.coerce.number().int().negative().optional()),
    /** In a forum-enabled admin group, open one topic per ticket. */
    ADMIN_USE_TOPICS: booleanFlag(false),
    /**
     * `command`: users send /feedback, then one message opens a ticket.
     * `direct`: every private message goes to the user's open ticket (or opens one).
     */
    INTAKE_MODE: z.enum(['command', 'direct']).default('command'),
    /** Tell users when their ticket is resolved, closed or reopened. */
    NOTIFY_USER_ON_STATUS: booleanFlag(true),

    WEBHOOK_SECRET: optionalTrimmed,
    WEBHOOK_PATH: webhookPathSchema,
    PUBLIC_URL: optionalTrimmed,
    METRICS_TOKEN: optionalTrimmed,
    SENTRY_DSN: optionalTrimmed,
    RELEASE_ID: optionalTrimmed,
    SUPPORT_CONTACT: optionalTrimmed,
    PRIVACY_POLICY_URL: optionalTrimmed,
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    /** Language for users without a stored preference and for admin notifications. */
    DEFAULT_LANGUAGE: z.enum(LANGUAGES).default('zh'),
    /** IANA time zone for times shown in chats, e.g. Europe/Rome or Asia/Shanghai. */
    TIME_ZONE: z.preprocess(
      blankToUndefined,
      z
        .string()
        .trim()
        .refine(isTimeZone, 'Unknown time zone; use an IANA name such as Europe/Rome')
        .default('UTC'),
    ),
    /** Optional HTTP port for the worker's /live and /ready probes (0 disables). */
    WORKER_HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(0),
    /** Fallback outbox scan interval; LISTEN/NOTIFY normally wakes the worker immediately. */
    OUTBOX_POLL_MS: z.coerce.number().int().min(500).max(300_000).default(5_000),
    /** Parallel sends to different chats (messages to one chat always stay in order). */
    DELIVERY_CONCURRENCY: z.coerce.number().int().min(1).max(30).default(4),
    /** LISTEN/NOTIFY needs a session connection; disable behind transaction-mode poolers. */
    OUTBOX_LISTEN: booleanFlag(true),
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).max(600).default(0),
    /** Delete tickets with no activity for this many days (0 keeps them). */
    FEEDBACK_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(0),
  })
  .superRefine((data, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (data.PRIVACY_POLICY_URL && !httpsUrl(data.PRIVACY_POLICY_URL))
      issue('PRIVACY_POLICY_URL', 'Use an HTTPS privacy policy URL');
    if (data.BOT_MODE === 'webhook' && (!data.WEBHOOK_SECRET || data.WEBHOOK_SECRET.length < 24))
      issue('WEBHOOK_SECRET', 'Webhook mode requires WEBHOOK_SECRET with at least 24 characters');
    if (data.WEBHOOK_SECRET && !secretTokenPattern.test(data.WEBHOOK_SECRET))
      issue(
        'WEBHOOK_SECRET',
        'Telegram secret_token allows only A-Z, a-z, 0-9, underscore, dash (max 256)',
      );
    if (data.ADMIN_TELEGRAM_ID) {
      const id = Number(data.ADMIN_TELEGRAM_ID);
      if (!Number.isSafeInteger(id) || id <= 0) issue('ADMIN_TELEGRAM_ID', 'Invalid safe integer');
    }
    if (data.ADMIN_USE_TOPICS && data.ADMIN_CHAT_ID === undefined)
      issue('ADMIN_USE_TOPICS', 'Topics require ADMIN_CHAT_ID (a forum-enabled supergroup)');
    if (data.PUBLIC_URL && !httpsUrl(data.PUBLIC_URL, true))
      issue('PUBLIC_URL', 'Use an HTTPS base URL');
    if (data.REDIS_URL) {
      try {
        if (!['redis:', 'rediss:'].includes(new URL(data.REDIS_URL).protocol)) throw new Error();
      } catch {
        issue('REDIS_URL', 'Use redis:// or rediss://');
      }
    }
    if (data.METRICS_TOKEN && data.METRICS_TOKEN.length < 24)
      issue('METRICS_TOKEN', 'Minimum 24 characters');
  })
  .transform(({ ADMIN_TELEGRAM_ID, ...data }) => ({
    ...data,
    ADMIN_IDS: [
      ...new Set([...data.ADMIN_IDS, ...(ADMIN_TELEGRAM_ID ? [Number(ADMIN_TELEGRAM_ID)] : [])]),
    ],
  }));

export type AppConfig = z.infer<typeof configSchema>;

export function parseConfig(values: Record<string, unknown> = process.env): AppConfig {
  const parsed = configSchema.safeParse(values);
  if (parsed.success) return parsed.data;
  const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  throw new Error(`Invalid environment configuration: ${details}`);
}

/** True when someone will receive new-ticket notifications. */
export function hasSupportTeam(config: Pick<AppConfig, 'ADMIN_IDS' | 'ADMIN_CHAT_ID'>): boolean {
  return config.ADMIN_CHAT_ID !== undefined || config.ADMIN_IDS.length > 0;
}

/**
 * Telegram CLI commands must not need a database URL or Redis credentials.
 * This is deliberately narrower than the runtime configuration.
 */
const telegramCliSchema = z.object({
  // Sequential delivery protects the stateful intake flow by default.
  // Increase only after testing out-of-order and duplicate updates.
  WEBHOOK_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(100).default(1),
  BOT_TOKEN: tokenSchema,
  WEBHOOK_SECRET: optionalTrimmed,
  WEBHOOK_PATH: webhookPathSchema,
  PUBLIC_URL: optionalTrimmed,
  ADMIN_IDS: idList,
  ADMIN_TELEGRAM_ID: optionalTrimmed,
  ADMIN_CHAT_ID: z.preprocess(blankToUndefined, z.coerce.number().int().negative().optional()),
});

export type TelegramCliConfig = Omit<z.infer<typeof telegramCliSchema>, 'ADMIN_TELEGRAM_ID'>;

export function parseTelegramCliConfig(
  values: Record<string, unknown> = process.env,
): TelegramCliConfig {
  const config = telegramCliSchema.safeParse(values);
  if (!config.success) {
    throw new Error(
      `Invalid Telegram CLI configuration: ${config.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  }
  const { WEBHOOK_SECRET, PUBLIC_URL, ADMIN_TELEGRAM_ID, ...rest } = config.data;
  if (WEBHOOK_SECRET && !secretTokenPattern.test(WEBHOOK_SECRET))
    throw new Error('Invalid WEBHOOK_SECRET character set or length');
  if (PUBLIC_URL && !httpsUrl(PUBLIC_URL)) throw new Error('PUBLIC_URL must be an HTTPS base URL');
  const legacy = Number(ADMIN_TELEGRAM_ID);
  return {
    ...rest,
    WEBHOOK_SECRET,
    PUBLIC_URL,
    ADMIN_IDS: [
      ...new Set([...rest.ADMIN_IDS, ...(Number.isSafeInteger(legacy) && legacy > 0 ? [legacy] : [])]),
    ],
  };
}
