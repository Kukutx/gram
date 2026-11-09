export const WINDOW_MS = 60_000;
const MAX_MEMORY_USERS = 20_000;

/**
 * Simple fixed window, bounded to avoid retaining an unbounded number of
 * accounts in memory. This protects a single instance; Redis is authoritative
 * across instances when available.
 */
export class InMemoryRateLimiter {
  private readonly counts = new Map<number, { bucket: number; count: number }>();

  private readonly requestsPerMinute: number;

  constructor(requestsPerMinute: number) {
    this.requestsPerMinute = requestsPerMinute;
  }

  forget(userId: number): void {
    this.counts.delete(userId);
  }

  allow(userId: number, nowMs = Date.now()): boolean {
    if (this.requestsPerMinute === 0) return true;
    const bucket = Math.floor(nowMs / WINDOW_MS);
    const existing = this.counts.get(userId);
    const count = existing?.bucket === bucket ? existing.count + 1 : 1;
    // Recover bounded memory even during a burst of distinct Telegram users.
    if (this.counts.size >= MAX_MEMORY_USERS && !this.counts.has(userId)) {
      for (const [key, value] of this.counts) {
        if (value.bucket !== bucket) this.counts.delete(key);
      }
      if (this.counts.size >= MAX_MEMORY_USERS) this.counts.clear();
    }
    this.counts.set(userId, { bucket, count });
    return count <= this.requestsPerMinute;
  }
}

/** Fixed-window Redis atomic increment + TTL, shared across Cloud Run instances. */
export const REDIS_RATE_LIMIT_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n
`;

/** Data erasure and privacy notices remain accessible during abuse throttling. */
export function isPrivacyCommand(text: string | undefined): boolean {
  const command = text?.trim().split(/\s+/, 1)[0]?.toLowerCase().split('@', 1)[0];
  return (
    command === '/delete_my_data' ||
    command === '/privacy' ||
    command === '/my_data' ||
    command === '/export_my_data' ||
    command === '/export_my_replies'
  );
}

/** Confirmation callbacks must remain usable even when the user is throttled. */
export function isPrivacyCallback(data: string | undefined): boolean {
  return data?.startsWith('erase:') ?? false;
}
