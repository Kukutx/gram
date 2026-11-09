import pino from 'pino';
import type { AppConfig } from '../config/env.ts';
import type { DestinationStream } from 'pino';

/** Never serialize third-party messages, stacks, payloads, URLs or request objects. */
export function safeError(error: unknown): { type: string; code?: number | string } {
  if (!error || typeof error !== 'object') return { type: 'Error' };
  const data = error as Record<string, unknown>;
  const allowed = ['GrammyError', 'HttpError', 'Error', 'PrismaClientKnownRequestError'];
  const type = typeof data.name === 'string' && allowed.includes(data.name) ? data.name : 'Error';
  const code = data.error_code ?? data.code;
  return {
    type,
    ...(typeof code === 'number' || (typeof code === 'string' && /^[A-Z0-9_]{1,20}$/.test(code))
      ? { code }
      : {}),
  };
}

export function createLogger(config: Pick<AppConfig, 'LOG_LEVEL'>, destination?: DestinationStream) {
  const options: pino.LoggerOptions = {
    level: config.LOG_LEVEL,
    redact: {
      paths: [
        'req.headers.authorization',
        "req.headers['x-telegram-bot-api-secret-token']",
        'token',
        'BOT_TOKEN',
      ],
      censor: '[REDACTED]',
    },
    base: { app: 'grammy-production-bot' },
    serializers: { err: safeError },
  };
  return destination ? pino(options, destination) : pino(options);
}

export type Logger = ReturnType<typeof createLogger>;
