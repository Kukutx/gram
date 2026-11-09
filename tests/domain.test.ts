import { describe, expect, it } from 'vitest';
import { expiresInFifteenMinutes, summarizeFeedback, validateFeedback } from '../src/domain/feedback.ts';
import { normalizeLanguage, t } from '../src/domain/i18n.ts';

describe('feedback validation', () => {
  it('rejects blank content and commands', () => {
    expect(validateFeedback('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(validateFeedback('/stats')).toEqual({ ok: false, reason: 'command' });
  });

  it('trims valid content and restricts Unicode code points', () => {
    expect(validateFeedback(' hello ')).toEqual({ ok: true, text: 'hello' });
    expect(validateFeedback('🚀'.repeat(2001))).toEqual({ ok: false, reason: 'too_long' });
    expect(validateFeedback('🚀'.repeat(2000)).ok).toBe(true);
  });

  it('handles expiry and summaries deterministically', () => {
    expect(expiresInFifteenMinutes(new Date('2026-01-01T00:00:00Z')).toISOString()).toBe(
      '2026-01-01T00:15:00.000Z',
    );
    expect(summarizeFeedback('abcdef', 4)).toBe('abc…');
  });
});

describe('localization', () => {
  it('defaults to Chinese and recognizes English regional codes', () => {
    expect(normalizeLanguage('en-US')).toBe('en');
    expect(normalizeLanguage(undefined)).toBe('zh');
    expect(normalizeLanguage('fr')).toBe('zh');
  });
  it('renders localized placeholders', () => {
    expect(t('zh', 'id', { userId: 123, chatId: -456 })).toContain('123');
    expect(t('en', 'id', { userId: 123, chatId: -456 })).toContain('-456');
  });
});
