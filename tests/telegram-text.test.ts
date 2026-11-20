import { describe, expect, it } from 'vitest';
import {
  TELEGRAM_TEXT_MAX_UNITS,
  truncateTelegramText,
  withHeader,
} from '../src/domain/telegram-text.ts';
import { t } from '../src/domain/i18n.ts';

describe('Telegram outbound message bounds', () => {
  it('preserves short messages and truncates long text', () => {
    expect(truncateTelegramText('ok', 10)).toBe('ok');
    expect(truncateTelegramText('abcde', 3)).toBe('ab…');
    expect(truncateTelegramText('abc', 1)).toBe('…');
    expect(() => truncateTelegramText('a', 0)).toThrow(RangeError);
  });

  it('never splits a surrogate pair', () => {
    const cut = truncateTelegramText('a🚀🚀', 3);
    expect(cut).not.toContain('\ud83d…');
    expect(cut.length).toBeLessThanOrEqual(3);
  });

  it('fits oversized Unicode content under a notification header', () => {
    const header = t('en', 'notifyNewTicket', { number: 42, author: '@example' });
    const msg = withHeader(header, '🚀'.repeat(3_000));
    expect(msg.length).toBeLessThanOrEqual(TELEGRAM_TEXT_MAX_UNITS);
    expect(msg.startsWith(header)).toBe(true);
    expect(msg).toContain('#42');
    expect(msg.endsWith('…')).toBe(true);
  });

  it('rejects impossible oversized headers', () => {
    expect(() => withHeader('A'.repeat(5_000), 'text')).toThrow(RangeError);
  });
});
