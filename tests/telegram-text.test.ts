import { describe, expect, it } from 'vitest';
import {
  buildFeedbackNotification,
  TELEGRAM_TEXT_MAX_UNITS,
  truncateTelegramText,
} from '../src/domain/telegram-text.ts';

describe('Telegram outbound message bounds', () => {
  it('preserves short messages and truncates long text', () => {
    expect(truncateTelegramText('ok', 10)).toBe('ok');
    expect(truncateTelegramText('abcde', 3)).toBe('ab…');
    expect(truncateTelegramText('abc', 1)).toBe('…');
    expect(() => truncateTelegramText('a', 0)).toThrow(RangeError);
  });

  it('never slices an emoji surrogate pair in half', () => {
    expect(truncateTelegramText('🔐abc', 3)).toBe('🔐…');
    expect(truncateTelegramText('🔐abc', 2)).toBe('…');
  });

  it('fits even unexpectedly oversized Unicode content within one Telegram notification', () => {
    const content = '🚀'.repeat(3_000);
    const msg = buildFeedbackNotification('example', 'cuid01234', content);
    expect(msg.length).toBeLessThanOrEqual(TELEGRAM_TEXT_MAX_UNITS);
    expect(msg).toContain('ID: cuid01234');
    expect(msg.endsWith('…')).toBe(true);
    expect(msg).not.toContain('\ud800');
  });

  it('rejects impossible oversized header inputs', () => {
    expect(() => buildFeedbackNotification('A'.repeat(5_000), 'id', 'text')).toThrow(RangeError);
  });
});
