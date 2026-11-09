import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/observability/logger.ts';
import { parseConfig } from '../src/config/env.ts';
import { GrammyError } from 'grammy';

describe('structured logger security', () => {
  it('never serializes Telegram payloads, raw messages, stacks or credentials', () => {
    const lines: string[] = [];
    const logger = createLogger(
      { LOG_LEVEL: 'error' },
      {
        write: (line: string) => {
          lines.push(line);
        },
      },
    );
    const error = new GrammyError(
      'SENSITIVE_TOKEN',
      { ok: false, error_code: 403, description: 'SENSITIVE_DESCRIPTION' },
      'sendMessage',
      { chat_id: 987654321, text: 'PRIVATE_FEEDBACK' },
    );
    logger.error({ err: error }, 'Synthetic failure');
    expect(lines.join('')).not.toMatch(/SENSITIVE|PRIVATE_FEEDBACK|987654321|payload|stack/);
    expect(JSON.parse(lines[0]!).err).toEqual({ type: 'GrammyError', code: 403 });
  });
  it('constructs with valid fast-redact paths for hyphenated Telegram headers', () => {
    const config = parseConfig({
      BOT_TOKEN: '123456789:AAAAAAAAAAAAAAA',
      DATABASE_URL: 'postgresql://bot:pass@localhost:5432/test',
    });
    const logger = createLogger(config);
    expect(logger).toBeDefined();
    expect(logger.level).toBe('info');
  });
});
