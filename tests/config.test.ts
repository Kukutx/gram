import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/env.ts';

const base = {
  BOT_TOKEN: '123456789:AAAAAAAAAAAAAAA',
  DATABASE_URL: 'postgresql://bot:bot_password@localhost:5432/bot',
};

describe('configuration validation', () => {
  it('defaults to polling and validates types', () => {
    const config = parseConfig(base);
    expect(config.BOT_MODE).toBe('polling');
    expect(config.PORT).toBe(3000);
    expect(config.RATE_LIMIT_PER_MINUTE).toBe(0);
    expect(config.FEEDBACK_RETENTION_DAYS).toBe(0);
  });
  it('checks rate limiting and retention settings', () => {
    expect(() => parseConfig({ ...base, RATE_LIMIT_PER_MINUTE: -1 })).toThrow(/RATE_LIMIT_PER_MINUTE/);
    expect(() => parseConfig({ ...base, FEEDBACK_RETENTION_DAYS: 3651 })).toThrow(
      /FEEDBACK_RETENTION_DAYS/,
    );
    expect(
      parseConfig({ ...base, RATE_LIMIT_PER_MINUTE: 0, FEEDBACK_RETENTION_DAYS: 30 })
        .FEEDBACK_RETENTION_DAYS,
    ).toBe(30);
  });
  it('requires a secret for webhook', () => {
    expect(() => parseConfig({ ...base, BOT_MODE: 'webhook' })).toThrow(/WEBHOOK_SECRET/);
    expect(parseConfig({ ...base, BOT_MODE: 'webhook', WEBHOOK_SECRET: 'a'.repeat(32) }).BOT_MODE).toBe(
      'webhook',
    );
  });
  it('rejects non-integer administrator ids', () => {
    expect(() => parseConfig({ ...base, ADMIN_TELEGRAM_ID: 'abc' })).toThrow(/ADMIN_TELEGRAM_ID/);
  });
  it('checks Redis URL and public URL protocol', () => {
    expect(() => parseConfig({ ...base, REDIS_URL: 'http://localhost' })).toThrow(/REDIS_URL/);
    expect(() => parseConfig({ ...base, PUBLIC_URL: 'http://example.com' })).toThrow(/PUBLIC_URL/);
  });
});

describe('Telegram-only management CLI', () => {
  it('does not require DATABASE_URL for webhook management or commands', async () => {
    const { parseTelegramCliConfig } = await import('../src/config/env.ts');
    const parsed = parseTelegramCliConfig({ BOT_TOKEN: base.BOT_TOKEN });
    expect(parsed.WEBHOOK_PATH).toBe('/telegram/webhook');
    expect(parsed.WEBHOOK_MAX_CONNECTIONS).toBe(1);
    expect(
      parseTelegramCliConfig({ BOT_TOKEN: base.BOT_TOKEN, WEBHOOK_MAX_CONNECTIONS: 20 })
        .WEBHOOK_MAX_CONNECTIONS,
    ).toBe(20);
  });
  it('rejects malformed webhook secrets and non-HTTPS URLs', async () => {
    const { parseTelegramCliConfig } = await import('../src/config/env.ts');
    expect(() =>
      parseTelegramCliConfig({ BOT_TOKEN: base.BOT_TOKEN, WEBHOOK_SECRET: 'bad secret' }),
    ).toThrow();
    expect(() =>
      parseTelegramCliConfig({ BOT_TOKEN: base.BOT_TOKEN, PUBLIC_URL: 'http://example.com' }),
    ).toThrow();
    expect(() =>
      parseTelegramCliConfig({ BOT_TOKEN: base.BOT_TOKEN, WEBHOOK_MAX_CONNECTIONS: 101 }),
    ).toThrow();
  });
});
