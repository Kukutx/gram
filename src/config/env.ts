import { z } from 'zod';

const optionalTrimmed = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().optional(),
);

const tokenSchema = z.string().regex(/^\d{5,16}:[A-Za-z0-9_-]{10,}$/, 'Invalid BotFather token format');
const webhookPathSchema = z
  .string()
  .regex(/^\/[A-Za-z0-9/_-]+$/)
  .default('/telegram/webhook');

const configSchema = z
  .object({
    BOT_TOKEN: tokenSchema,
    BOT_MODE: z.enum(['polling', 'webhook']).default('polling'),
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'Requires a PostgreSQL URL'),
    REDIS_URL: optionalTrimmed,
    ADMIN_TELEGRAM_ID: optionalTrimmed,
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
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).max(600).default(0),
    FEEDBACK_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(0),
  })
  .superRefine((data, ctx) => {
    if (data.PRIVACY_POLICY_URL) {
      try {
        if (new URL(data.PRIVACY_POLICY_URL).protocol !== 'https:') throw new Error();
      } catch {
        ctx.addIssue({
          code: 'custom',
          path: ['PRIVACY_POLICY_URL'],
          message: 'Use an HTTPS privacy policy URL',
        });
      }
    }
    if (data.BOT_MODE === 'webhook' && (!data.WEBHOOK_SECRET || data.WEBHOOK_SECRET.length < 24)) {
      ctx.addIssue({
        code: 'custom',
        path: ['WEBHOOK_SECRET'],
        message: 'Webhook mode requires WEBHOOK_SECRET with at least 24 characters',
      });
    }
    if (data.WEBHOOK_SECRET && !/^[A-Za-z0-9_-]{1,256}$/.test(data.WEBHOOK_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['WEBHOOK_SECRET'],
        message: 'Telegram secret_token allows only A-Z, a-z, 0-9, underscore, dash (max 256)',
      });
    }
    if (data.ADMIN_TELEGRAM_ID) {
      const id = Number(data.ADMIN_TELEGRAM_ID);
      if (!Number.isSafeInteger(id) || id <= 0) {
        ctx.addIssue({ code: 'custom', path: ['ADMIN_TELEGRAM_ID'], message: 'Invalid safe integer' });
      }
    }
    if (data.PUBLIC_URL) {
      try {
        const uri = new URL(data.PUBLIC_URL);
        if (uri.protocol !== 'https:' && uri.hostname !== 'localhost') throw Error('https required');
      } catch {
        ctx.addIssue({ code: 'custom', path: ['PUBLIC_URL'], message: 'Use an HTTPS base URL' });
      }
    }
    if (data.REDIS_URL) {
      try {
        const uri = new URL(data.REDIS_URL);
        if (!['redis:', 'rediss:'].includes(uri.protocol)) throw Error('Redis scheme required');
      } catch {
        ctx.addIssue({ code: 'custom', path: ['REDIS_URL'], message: 'Use redis:// or rediss://' });
      }
    }
    if (data.METRICS_TOKEN && data.METRICS_TOKEN.length < 24) {
      ctx.addIssue({ code: 'custom', path: ['METRICS_TOKEN'], message: 'Minimum 24 characters' });
    }
  });

export type AppConfig = z.infer<typeof configSchema>;

export function parseConfig(values: Record<string, unknown> = process.env): AppConfig {
  const parsed = configSchema.safeParse(values);
  if (parsed.success) return parsed.data;
  const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  throw new Error(`Invalid environment configuration: ${details}`);
}

export function adminId(config: AppConfig): number | undefined {
  return config.ADMIN_TELEGRAM_ID ? Number(config.ADMIN_TELEGRAM_ID) : undefined;
}

/**
 * Telegram CLI commands must not need a database URL or Redis credentials.
 * This is deliberately narrower than the runtime configuration.
 */
const telegramCliSchema = z.object({
  // Sequential delivery protects the simple stateful feedback flow by default.
  // Increase only after testing out-of-order and duplicate updates.
  WEBHOOK_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(100).default(1),
  BOT_TOKEN: tokenSchema,
  WEBHOOK_SECRET: optionalTrimmed,
  WEBHOOK_PATH: webhookPathSchema,
  PUBLIC_URL: optionalTrimmed,
});

export type TelegramCliConfig = z.infer<typeof telegramCliSchema>;

export function parseTelegramCliConfig(
  values: Record<string, unknown> = process.env,
): TelegramCliConfig {
  const config = telegramCliSchema.safeParse(values);
  if (!config.success) {
    throw new Error(
      `Invalid Telegram CLI configuration: ${config.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  }
  const { WEBHOOK_SECRET, PUBLIC_URL } = config.data;
  if (WEBHOOK_SECRET && !/^[A-Za-z0-9_-]{1,256}$/.test(WEBHOOK_SECRET)) {
    throw new Error('Invalid WEBHOOK_SECRET character set or length');
  }
  if (PUBLIC_URL) {
    try {
      const url = new URL(PUBLIC_URL);
      if (url.protocol !== 'https:') throw new Error('HTTPS required');
    } catch {
      throw new Error('PUBLIC_URL must be an HTTPS base URL');
    }
  }
  return config.data;
}
