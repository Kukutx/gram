/**
 * Telegram sendMessage accepts at most 4096 text characters. Counting UTF-16
 * code units is conservative for emoji/surrogate pairs and prevents a message
 * from being rejected for oversize Unicode payloads.
 */
export const TELEGRAM_TEXT_MAX_UNITS = 4096;

export function truncateTelegramText(text: string, maxUnits: number): string {
  if (!Number.isSafeInteger(maxUnits) || maxUnits < 1)
    throw new RangeError('maxUnits must be a positive integer');
  if (text.length <= maxUnits) return text;
  if (maxUnits === 1) return '…';
  let cut = maxUnits - 1; // Reserve one UTF-16 unit for the ellipsis.
  // Don't split a high-surrogate/low-surrogate pair at the end of the slice.
  const lastUnit = text.charCodeAt(cut - 1);
  const nextUnit = text.charCodeAt(cut);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff && nextUnit >= 0xdc00 && nextUnit <= 0xdfff) {
    cut -= 1;
  }
  return `${text.slice(0, cut)}…`;
}

export function buildFeedbackNotification(author: string, feedbackId: string, content: string): string {
  const header = `📝 New feedback\nFrom: ${author}\nID: ${feedbackId}\n\n`;
  const remaining = TELEGRAM_TEXT_MAX_UNITS - header.length;
  if (remaining < 1) throw new RangeError('Feedback notification header exceeds Telegram limit');
  return header + truncateTelegramText(content, remaining);
}
