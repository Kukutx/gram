import { describe, expect, it } from 'vitest';
import { createAlerter, workerProblems } from '../src/observability/alerts.ts';
import type { OperationsHealth } from '../src/observability/operations.ts';
import { ticketEventLabel } from '../src/domain/i18n.ts';

function recorder() {
  const sent: { chat: number; text: string }[] = [];
  const alerter = createAlerter({
    send: async (chat, text) => sent.push({ chat, text }),
    chats: [1, 2],
    language: 'en',
    onError: (error) => {
      throw error;
    },
  });
  return { sent, alerter };
}

const healthy = {
  healthy: true,
  workerFresh: true,
  dispatchFresh: true,
  retentionFresh: true,
  pending: 0,
  blocked: 0,
  retentionOverdueSeconds: 0,
  status: 'empty',
  oldestPendingAgeSeconds: null,
} as unknown as OperationsHealth;

describe('health alerts', () => {
  it('derives problems from operational health', () => {
    expect(workerProblems(healthy)).toEqual([]);
    expect(
      workerProblems({
        ...healthy,
        dispatchFresh: false,
        status: 'critical',
        pending: 3,
        oldestPendingAgeSeconds: 3_900,
        blocked: 2,
        retentionOverdueSeconds: 600,
      }),
    ).toEqual([
      { kind: 'dispatch' },
      { kind: 'backlog', pending: 3, minutes: 65 },
      { kind: 'blocked', blocked: 2 },
      { kind: 'retention' },
    ]);
  });

  it('alerts every admin once per new problem, again only when it grows, and on recovery', async () => {
    const { sent, alerter } = recorder();
    await alerter.update([]);
    expect(sent).toHaveLength(0);

    await alerter.update([{ kind: 'blocked', blocked: 1 }]);
    expect(sent.map((m) => m.chat)).toEqual([1, 2]);
    expect(sent[0]!.text).toContain('1 message(s) could not be delivered');

    await alerter.update([{ kind: 'blocked', blocked: 1 }]); // unchanged: quiet
    expect(sent).toHaveLength(2);
    await alerter.update([{ kind: 'blocked', blocked: 3 }]); // more failures: tell again
    expect(sent).toHaveLength(4);
    await alerter.update([{ kind: 'blocked', blocked: 2 }]); // one dismissed: quiet
    expect(sent).toHaveLength(4);

    await alerter.update([{ kind: 'blocked', blocked: 2 }, { kind: 'worker' }]);
    expect(sent).toHaveLength(6);
    expect(sent.at(-1)!.text).toContain('not responding');

    await alerter.update([]);
    expect(sent).toHaveLength(8);
    expect(sent.at(-1)!.text).toContain('healthy again');
    await alerter.update([]);
    expect(sent).toHaveLength(8);

    await alerter.update([{ kind: 'dispatch' }]); // a problem that returns is announced again
    expect(sent).toHaveLength(10);
  });

  it('keeps alerting the other admins when one chat fails', async () => {
    const errors: unknown[] = [];
    const delivered: number[] = [];
    const alerter = createAlerter({
      send: async (chat) => {
        if (chat === 1) throw new Error('blocked');
        delivered.push(chat);
      },
      chats: [1, 2],
      language: 'zh',
      onError: (error) => errors.push(error),
    });
    await alerter.update([{ kind: 'worker' }]);
    expect(delivered).toEqual([2]);
    expect(errors).toHaveLength(1);
  });
});

describe('ticket history labels', () => {
  it('localizes known events and keeps legacy ones verbatim', () => {
    expect(ticketEventLabel('zh', 'assign')).toBe('受理');
    expect(ticketEventLabel('zh', 'resolved')).toBe('已解决');
    expect(ticketEventLabel('en', 'reopened_by_user')).toBe('reopened by user');
    expect(ticketEventLabel('en', 'legacy_thing')).toBe('legacy_thing');
  });
});
