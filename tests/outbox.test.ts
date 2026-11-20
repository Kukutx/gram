import { describe, expect, it } from 'vitest';
import { MAX_TEMPORARY_ATTEMPTS, RETRY_BASE_MS, RETRY_MAX_MS, retryDelayMs } from '../src/db/outbox.ts';

describe('outbox retry schedule', () => {
  it('backs off exponentially from the base delay and caps at the maximum', () => {
    expect(retryDelayMs(1)).toBe(RETRY_BASE_MS);
    expect(retryDelayMs(2)).toBe(RETRY_BASE_MS * 2);
    expect(retryDelayMs(5)).toBe(RETRY_BASE_MS * 16);
    expect(retryDelayMs(100)).toBe(RETRY_MAX_MS);
  });
  it('treats nonsense attempt counts as the first attempt', () => {
    expect(retryDelayMs(0)).toBe(RETRY_BASE_MS);
    expect(retryDelayMs(-3)).toBe(RETRY_BASE_MS);
  });
  it('gives up on temporary errors within roughly a day', () => {
    let total = 0;
    for (let attempt = 1; attempt < MAX_TEMPORARY_ATTEMPTS; attempt++) total += retryDelayMs(attempt);
    expect(total).toBeGreaterThan(60 * 60_000);
    expect(total).toBeLessThan(24 * 60 * 60_000);
  });
});
