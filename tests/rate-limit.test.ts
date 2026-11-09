import { describe, expect, it } from 'vitest';
import { InMemoryRateLimiter, isPrivacyCommand } from '../src/security/rate-limit-domain.ts';

describe('rate limiting', () => {
  it('enforces per-user limits within a minute and resets next minute', () => {
    const limiter = new InMemoryRateLimiter(2);
    expect(limiter.allow(1, 60_000)).toBe(true);
    expect(limiter.allow(1, 60_001)).toBe(true);
    expect(limiter.allow(1, 60_002)).toBe(false);
    expect(limiter.allow(2, 60_002)).toBe(true);
    limiter.forget(1);
    expect(limiter.allow(1, 60_003)).toBe(true);
    expect(limiter.allow(1, 120_000)).toBe(true);
  });
  it('zero disables limits and data access/erasure commands bypass limits', () => {
    const unlimited = new InMemoryRateLimiter(0);
    for (let i = 0; i < 100; i++) expect(unlimited.allow(42, 60_000)).toBe(true);
    expect(isPrivacyCommand(' /delete_my_data@my_bot ')).toBe(true);
    expect(isPrivacyCommand('/privacy')).toBe(true);
    expect(isPrivacyCommand('/my_data')).toBe(true);
    expect(isPrivacyCommand('/start')).toBe(false);
  });
});

describe('privacy callback exemptions', () => {
  it('allows deletion confirmation and personal export regardless of throttling', async () => {
    const { isPrivacyCallback } = await import('../src/security/rate-limit-domain.ts');
    expect(isPrivacyCommand('/export_my_data')).toBe(true);
    expect(isPrivacyCallback('erase:cancel')).toBe(true);
    expect(isPrivacyCallback('erase:v1:123:signature')).toBe(true);
    expect(isPrivacyCallback('other:callback')).toBe(false);
  });
});
