/** Shared timing constants. Keep them here so policies cannot drift between modules. */
export const DAY_MS = 86_400_000;

/** Telegram picks a fresh random update_id sequence after a week without updates. */
export const RECEIPT_RETENTION_MS = 7 * DAY_MS;

/** A user's `lastSeenAt` is refreshed at most this often, avoiding a write per update. */
export const LAST_SEEN_REFRESH_MS = 5 * 60_000;

/** A heartbeat older than this is considered stale by health checks. */
export const HEARTBEAT_FRESH_MS = 120_000;
