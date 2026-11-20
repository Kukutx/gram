import type { Api } from 'grammy';
import { t, type Language, type TranslationKey } from '../domain/i18n.ts';
import type { OperationsHealth } from './operations.ts';

/** A problem worth a person's attention, with what the alert text needs. */
export type Problem =
  | { kind: 'worker' }
  | { kind: 'dispatch' }
  | { kind: 'backlog'; pending: number; minutes: number }
  | { kind: 'blocked'; blocked: number }
  | { kind: 'retention' };

const PROBLEM_KEYS = {
  worker: 'alertWorker',
  dispatch: 'alertDispatch',
  backlog: 'alertBacklog',
  blocked: 'alertBlocked',
  retention: 'alertRetention',
} as const satisfies Record<Problem['kind'], TranslationKey>;

/**
 * Problems the worker itself can see. Its own heartbeat is left to the bot process
 * (a stopped worker cannot report itself).
 */
export function workerProblems(health: OperationsHealth): Problem[] {
  const problems: Problem[] = [];
  if (!health.dispatchFresh) problems.push({ kind: 'dispatch' });
  if (health.status === 'warning' || health.status === 'critical')
    problems.push({
      kind: 'backlog',
      pending: health.pending,
      minutes: Math.floor((health.oldestPendingAgeSeconds ?? 0) / 60),
    });
  if (health.blocked > 0) problems.push({ kind: 'blocked', blocked: health.blocked });
  if (health.retentionOverdueSeconds >= 300) problems.push({ kind: 'retention' });
  return problems;
}

export type Alerter = {
  /** Reports the current problems; sends a message only when something new went wrong or all recovered. */
  update(problems: readonly Problem[]): Promise<void>;
};

/**
 * Telegram alerts to the admins, sent directly (not through the outbox, which may be
 * the thing that is broken). One message when a new problem appears or a count of
 * failed deliveries grows, one when everything is healthy again; never a repeat.
 */
export function createAlerter(deps: {
  send: (chatId: number, text: string) => Promise<unknown>;
  chats: readonly number[];
  language: Language;
  onError: (error: unknown) => void;
}): Alerter {
  let alerted = new Map<Problem['kind'], number>();
  const weight = (p: Problem) => (p.kind === 'blocked' ? p.blocked : 1);

  async function broadcast(text: string) {
    for (const chat of deps.chats) await deps.send(chat, text).catch(deps.onError);
  }

  return {
    async update(problems) {
      const current = new Map(problems.map((p) => [p.kind, weight(p)] as const));
      const worse = problems.some((p) => (alerted.get(p.kind) ?? 0) < weight(p));
      if (worse) {
        const lines = problems.map((p) => `• ${t(deps.language, PROBLEM_KEYS[p.kind], p)}`);
        await broadcast(`${t(deps.language, 'alertTitle')}\n${lines.join('\n')}`);
        alerted = current;
      } else if (problems.length === 0 && alerted.size > 0) {
        await broadcast(t(deps.language, 'alertRecovered'));
        alerted = current;
      } else {
        // Keep the high-water mark so a problem that eases and returns is not re-announced.
        for (const [kind, value] of current) alerted.set(kind, Math.max(alerted.get(kind) ?? 0, value));
        for (const kind of alerted.keys()) if (!current.has(kind)) alerted.delete(kind);
      }
    },
  };
}

/** Plain text, no markup: alerts must arrive even if a value contains special characters. */
export function telegramSender(api: Api) {
  return (chatId: number, text: string) =>
    api.sendMessage(chatId, text, { link_preview_options: { is_disabled: true } });
}
