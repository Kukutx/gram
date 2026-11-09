/**
 * Dependency-free checks. This is NOT a replacement for pnpm typecheck/test.
 * Node.js 24 can execute these locally-authored TS modules with type stripping.
 */
import assert from 'node:assert/strict';
import {
  InMemoryRateLimiter,
  isPrivacyCommand,
  isPrivacyCallback,
} from '../src/security/rate-limit-domain.ts';
import { outboxWhere, nextOutboxCursor } from '../src/queue/outbox.ts';
import { feedbackRetentionCutoff, purgeExpiredFeedback } from '../src/maintenance/retention.ts';
import {
  claimFeedbackDelivery,
  DELIVERY_LEASE_MS,
  markFeedbackDelivered,
  releaseFeedbackDelivery,
} from '../src/db/notification-lease.ts';
import { validateFeedback } from '../src/domain/feedback.ts';
import { t } from '../src/domain/i18n.ts';
import { classifyOutboxHealth, OUTBOX_WARNING_AGE_MS } from '../src/observability/outbox-health.ts';
import {
  buildFeedbackNotification,
  TELEGRAM_TEXT_MAX_UNITS,
  truncateTelegramText,
} from '../src/domain/telegram-text.ts';
import {
  decodeExportCursor,
  encodeExportCursor,
  exportFeedbackWhere,
  EXPORT_PAGE_SIZE,
  getPersonalDataExportPage,
} from '../src/privacy/export.ts';
import {
  createDeleteConfirmation,
  verifyDeleteConfirmation,
  DELETE_CONFIRM_TTL_SECONDS,
} from '../src/privacy/delete-confirm.ts';

let assertions = 0;
function eq(actual, expected) {
  assert.deepEqual(actual, expected);
  assertions++;
}

const limiter = new InMemoryRateLimiter(2);
eq(limiter.allow(11, 60_000), true);
eq(limiter.allow(11, 60_001), true);
eq(limiter.allow(11, 60_002), false);
limiter.forget(11);
eq(limiter.allow(11, 60_003), true);
eq(limiter.allow(11, 120_000), true);
eq(isPrivacyCommand('/delete_my_data@demo_bot'), true);
eq(isPrivacyCommand('/my_data'), true);
eq(isPrivacyCommand('/start'), false);
eq(isPrivacyCommand('/export_my_data'), true);
eq(isPrivacyCallback('erase:cancel'), true);
eq(isPrivacyCallback('erase:v1:123:signature'), true);
eq(isPrivacyCallback('random'), false);

const cursor = { createdAt: new Date('2026-10-12T11:00:00.000Z'), id: 'aaa' };
eq(nextOutboxCursor([cursor]), cursor);
eq(outboxWhere(cursor).OR.length, 2);
eq(feedbackRetentionCutoff(0), undefined);
eq(
  feedbackRetentionCutoff(30, new Date('2026-10-12T00:00:00Z')).toISOString(),
  '2026-09-12T00:00:00.000Z',
);

const calls = [];
const db = {
  feedback: {
    updateMany: async (request) => {
      calls.push(request);
      return { count: 1 };
    },
    findMany: async () => [{ id: 'f' }],
    deleteMany: async (request) => {
      calls.push(request);
      return { count: 1 };
    },
  },
};
eq(await claimFeedbackDelivery(db, 'f', 'token-1', new Date('2026-10-12T00:00:00Z')), true);
eq(
  calls[0].data.deliveryLeaseUntil.toISOString(),
  new Date(Date.parse('2026-10-12T00:00:00Z') + DELIVERY_LEASE_MS).toISOString(),
);
eq(await markFeedbackDelivered(db, 'f', 'token-1'), true);
await releaseFeedbackDelivery(db, 'f', 'token-1');
eq(calls.length, 3);
eq(await purgeExpiredFeedback(db, 30, new Date('2026-10-12T00:00:00Z')), 1);
eq(validateFeedback('  hello  ').text, 'hello');
eq(t('en', 'retentionEnabled', { days: 10 }).includes('10'), true);

const longMsg = buildFeedbackNotification('bot_admin', 'abc123', '🚀'.repeat(3000));
eq(longMsg.length <= TELEGRAM_TEXT_MAX_UNITS, true);
eq(longMsg.endsWith('…'), true);
eq(truncateTelegramText('🔐xyz', 2), '…');
const exportCursor = { createdAt: new Date('2026-10-12T15:00:00Z'), id: 'abc123' };
eq(decodeExportCursor(encodeExportCursor(exportCursor)), exportCursor);
eq(exportFeedbackWhere('my-user', exportCursor).userId, 'my-user');
assert.throws(() => decodeExportCursor('%bad'), /Invalid export cursor/);
assertions++;
const exportItems = Array.from({ length: EXPORT_PAGE_SIZE + 1 }, (_, i) => ({
  id: `id${String(i).padStart(3, '0')}`,
  text: 'Hello',
  createdAt: exportCursor.createdAt,
  notifiedAt: null,
}));
const exportDb = {
  telegramUser: {
    findUnique: async () => ({
      id: 'u1',
      telegramId: 123n,
      username: 'test',
      firstName: 'User',
      language: 'zh',
      createdAt: exportCursor.createdAt,
      updatedAt: exportCursor.createdAt,
      lastSeenAt: exportCursor.createdAt,
    }),
  },
  feedback: {
    findMany: async ({ where, take }) => {
      eq(where.userId, 'u1');
      eq(take, EXPORT_PAGE_SIZE + 1);
      return exportItems;
    },
  },
};
const exportPage = await getPersonalDataExportPage(exportDb, 123);
eq(exportPage.count, EXPORT_PAGE_SIZE);
eq(JSON.parse(exportPage.fileContents.toString('utf8')).user.telegramId, '123');
eq(decodeExportCursor(exportPage.nextCursor).id, 'id049');

const nowForHealth = new Date('2026-10-13T00:00:00Z');
eq(classifyOutboxHealth(0, null, nowForHealth).status, 'empty');
eq(
  classifyOutboxHealth(1, new Date(+nowForHealth - OUTBOX_WARNING_AGE_MS), nowForHealth).status,
  'warning',
);
eq(
  classifyOutboxHealth(1, new Date(+nowForHealth - 2 * OUTBOX_WARNING_AGE_MS), nowForHealth).status,
  'warning',
);

const signNow = Date.parse('2026-10-13T12:00:00Z');
const signedDelete = createDeleteConfirmation(12345, '123456789:AAAAAAAAAAAAAAA', signNow);
eq(Buffer.byteLength(signedDelete, 'utf8') <= 64, true);
eq(verifyDeleteConfirmation(signedDelete, 12345, '123456789:AAAAAAAAAAAAAAA', signNow), true);
eq(verifyDeleteConfirmation(signedDelete, 99999, '123456789:AAAAAAAAAAAAAAA', signNow), false);
eq(verifyDeleteConfirmation(signedDelete, 12345, '123456789:BBBBBBBBBBBBBBB', signNow), false);
eq(
  verifyDeleteConfirmation(
    signedDelete,
    12345,
    '123456789:AAAAAAAAAAAAAAA',
    signNow + (DELETE_CONFIRM_TTL_SECONDS + 1) * 1000,
  ),
  false,
);
console.log(`Offline smoke passed: ${assertions} assertions`);
