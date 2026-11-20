import { describe, expect, it } from 'vitest';
import {
  expiresInFifteenMinutes,
  parseTicketRef,
  summarizeFeedback,
  validateFeedback,
} from '../src/domain/feedback.ts';
import { extractContent, validateContent } from '../src/domain/content.ts';
import type { Message } from 'grammy/types';
import { normalizeLanguage, outboxHealthLabel, t } from '../src/domain/i18n.ts';
import { shortTime } from '../src/bot/render.ts';

describe('feedback validation', () => {
  it('rejects blank content and commands', () => {
    expect(validateFeedback('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(validateFeedback('/stats')).toEqual({ ok: false, reason: 'command' });
  });

  it('trims valid content and restricts Unicode code points', () => {
    expect(validateFeedback(' hello ')).toEqual({ ok: true, text: 'hello' });
    expect(validateFeedback('🚀'.repeat(4001))).toEqual({ ok: false, reason: 'too_long' });
    expect(validateFeedback('🚀'.repeat(4000)).ok).toBe(true);
  });

  it('handles expiry and summaries deterministically', () => {
    expect(expiresInFifteenMinutes(new Date('2026-01-01T00:00:00Z')).toISOString()).toBe(
      '2026-01-01T00:15:00.000Z',
    );
    expect(summarizeFeedback('abcdef', 4)).toBe('abc…');
  });
});

describe('ticket references', () => {
  it('accepts #12, 12 and stored IDs, nothing else', () => {
    expect(parseTicketRef('#12')).toEqual({ number: 12 });
    expect(parseTicketRef(' 7 ')).toEqual({ number: 7 });
    expect(parseTicketRef('cm3abcdefgh')).toEqual({ id: 'cm3abcdefgh' });
    expect(parseTicketRef('')).toBeNull();
    expect(parseTicketRef('#')).toBeNull();
    expect(parseTicketRef('short')).toBeNull();
    expect(parseTicketRef('../../etc')).toBeNull();
  });
});

describe('message content', () => {
  const message = (fields: Partial<Message>) =>
    ({
      message_id: 1,
      date: 0,
      chat: { id: 1, type: 'private', first_name: 'U' },
      ...fields,
    }) as Message;
  it('keeps text, captions and the largest photo size', () => {
    expect(extractContent(message({ text: ' hi ' }))).toEqual({ text: 'hi', attachment: null });
    expect(
      extractContent(
        message({
          caption: 'see',
          photo: [
            { file_id: 'small', file_unique_id: 's', width: 1, height: 1 },
            { file_id: 'big', file_unique_id: 'b', width: 9, height: 9 },
          ],
        }),
      ),
    ).toEqual({ text: 'see', attachment: { type: 'photo', fileId: 'big' } });
  });
  it('prefers animation over its document twin and rejects empty or unsupported messages', () => {
    const animation = { file_id: 'gif', file_unique_id: 'g', width: 1, height: 1, duration: 1 };
    const document = { file_id: 'doc', file_unique_id: 'd' };
    expect(extractContent(message({ animation, document }))?.attachment).toEqual({
      type: 'animation',
      fileId: 'gif',
    });
    expect(extractContent(message({ text: '   ' }))).toBeNull();
    expect(extractContent(message({ location: { latitude: 0, longitude: 0 } }))).toBeNull();
  });
  it('validates commands and length but lets attachments carry slash captions', () => {
    expect(validateContent(null)).toEqual({ ok: false, reason: 'empty' });
    expect(validateContent({ text: '/start', attachment: null })).toEqual({
      ok: false,
      reason: 'command',
    });
    expect(validateContent({ text: 'x'.repeat(4001), attachment: null })).toEqual({
      ok: false,
      reason: 'too_long',
    });
    expect(validateContent({ text: '/path', attachment: { type: 'document', fileId: 'f' } }).ok).toBe(
      true,
    );
  });
});

describe('localization', () => {
  it('defaults to Chinese and recognizes English regional codes', () => {
    expect(normalizeLanguage('en-US')).toBe('en');
    expect(normalizeLanguage(undefined)).toBe('zh');
    expect(normalizeLanguage('fr')).toBe('zh');
  });
  it('shows chat times in the configured time zone', () => {
    const winter = new Date('2026-11-20T18:36:00Z');
    expect(shortTime(winter)).toBe('2026-11-20 18:36');
    expect(shortTime(winter, 'Europe/Rome')).toBe('2026-11-20 19:36');
    expect(shortTime(winter, 'Asia/Shanghai')).toBe('2026-11-21 02:36');
    expect(shortTime(new Date('2026-07-01T22:00:00Z'), 'Europe/Rome')).toBe('2026-07-02 00:00');
  });
  it('labels outbox health in the user language', () => {
    expect(outboxHealthLabel('zh', 'empty')).toBe('无积压');
    expect(outboxHealthLabel('en', 'critical')).toContain('critical');
    expect(outboxHealthLabel('en', 'novel')).toBe('novel');
    expect(t('zh', 'status', { oldest: t('zh', 'none') })).toContain('最早待发送：无');
  });
  it('renders localized placeholders', () => {
    expect(t('zh', 'id', { userId: 123, chatId: -456 })).toContain('123');
    expect(t('en', 'id', { userId: 123, chatId: -456 })).toContain('-456');
  });
});
