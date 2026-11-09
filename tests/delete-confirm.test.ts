import { describe, expect, it } from 'vitest';
import {
  createDeleteConfirmation,
  verifyDeleteConfirmation,
  DELETE_CONFIRM_TTL_SECONDS,
} from '../src/privacy/delete-confirm.ts';

const TOKEN = '123456789:AAAAAAAAAAAAAAA';
const NOW = Date.parse('2026-10-13T12:00:00Z');

describe('time-limited user-bound data deletion confirmation', () => {
  it('is valid for the intended user, signed by the current Bot Token', () => {
    const data = createDeleteConfirmation(123456789, TOKEN, NOW);
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
    expect(verifyDeleteConfirmation(data, 123456789, TOKEN, NOW)).toBe(true);
    expect(verifyDeleteConfirmation(data, 987654321, TOKEN, NOW)).toBe(false);
    expect(verifyDeleteConfirmation(data, 123456789, '123456789:BBBBBBBBBB', NOW)).toBe(false);
  });

  it('rejects expiry, future-dated and malformed callback data', () => {
    const data = createDeleteConfirmation(123456789, TOKEN, NOW);
    expect(
      verifyDeleteConfirmation(data, 123456789, TOKEN, NOW + (DELETE_CONFIRM_TTL_SECONDS + 1) * 1000),
    ).toBe(false);
    expect(verifyDeleteConfirmation(data, 123456789, TOKEN, NOW - 1000)).toBe(false);
    expect(verifyDeleteConfirmation(data.replace(/.$/, 'x'), 123456789, TOKEN, NOW)).toBe(false);
    expect(verifyDeleteConfirmation('erase:v1:invalid', 123456789, TOKEN, NOW)).toBe(false);
    expect(verifyDeleteConfirmation('erase:cancel', 123456789, TOKEN, NOW)).toBe(false);
  });
});
