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
  it('accepts IANA time zones for chat timestamps', () => {
    expect(parseConfig(base).TIME_ZONE).toBe('UTC');
    expect(parseConfig({ ...base, TIME_ZONE: ' Europe/Rome ' }).TIME_ZONE).toBe('Europe/Rome');
    expect(parseConfig({ ...base, TIME_ZONE: '' }).TIME_ZONE).toBe('UTC');
    expect(() => parseConfig({ ...base, TIME_ZONE: 'Mars/Base' })).toThrow(/TIME_ZONE/);
  });
  it('requires a secret for webhook', () => {
    expect(() => parseConfig({ ...base, BOT_MODE: 'webhook' })).toThrow(/WEBHOOK_SECRET/);
    expect(parseConfig({ ...base, BOT_MODE: 'webhook', WEBHOOK_SECRET: 'a'.repeat(32) }).BOT_MODE).toBe(
      'webhook',
    );
  });
  it('rejects non-integer administrator ids', () => {
    expect(() => parseConfig({ ...base, ADMIN_TELEGRAM_ID: 'abc' })).toThrow(/ADMIN_TELEGRAM_ID/);
    expect(() => parseConfig({ ...base, ADMIN_IDS: '1, x' })).toThrow(/ADMIN_IDS/);
    expect(() => parseConfig({ ...base, ADMIN_CHAT_ID: '123' })).toThrow(/ADMIN_CHAT_ID/);
  });
  it('merges ADMIN_IDS with the deprecated single admin setting', () => {
    expect(parseConfig({ ...base, ADMIN_IDS: '1, 2 3', ADMIN_TELEGRAM_ID: '2' }).ADMIN_IDS).toEqual([
      1, 2, 3,
    ]);
    expect(parseConfig({ ...base, ADMIN_TELEGRAM_ID: '9' }).ADMIN_IDS).toEqual([9]);
    expect(parseConfig(base).ADMIN_IDS).toEqual([]);
    expect(parseConfig(base)).not.toHaveProperty('ADMIN_TELEGRAM_ID');
  });
  it('requires a support group for forum topics and parses intake options', () => {
    expect(() => parseConfig({ ...base, ADMIN_USE_TOPICS: 'true' })).toThrow(/ADMIN_USE_TOPICS/);
    const config = parseConfig({
      ...base,
      ADMIN_CHAT_ID: '-1001234567890',
      ADMIN_USE_TOPICS: 'yes',
      INTAKE_MODE: 'direct',
      NOTIFY_USER_ON_STATUS: 'off',
    });
    expect(config).toMatchObject({
      ADMIN_CHAT_ID: -1001234567890,
      ADMIN_USE_TOPICS: true,
      INTAKE_MODE: 'direct',
      NOTIFY_USER_ON_STATUS: false,
    });
    expect(() => parseConfig({ ...base, INTAKE_MODE: 'chat' })).toThrow(/INTAKE_MODE/);
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
    expect(
      parseTelegramCliConfig({ BOT_TOKEN: base.BOT_TOKEN, ADMIN_IDS: '5', ADMIN_TELEGRAM_ID: '6' })
        .ADMIN_IDS,
    ).toEqual([5, 6]);
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
