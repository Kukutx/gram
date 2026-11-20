import type { Transformer } from 'grammy';

/** Synthetic Telegram transport; fixture responses intentionally cover only called methods. */
export function fakeTelegram(handler: (method: string) => unknown | Promise<unknown>): Transformer {
  return (async (_previous: unknown, method: string) => handler(method)) as Transformer;
}

export type RecordedCall = { method: string; payload: Record<string, unknown> };

/**
 * A recording Telegram double that answers every method plausibly: sends return a
 * message with an increasing ID, topics get thread 9000+, everything else `true`.
 */
export function recordingTelegram(options: { fail?: (call: RecordedCall) => unknown } = {}) {
  const calls: RecordedCall[] = [];
  let messageId = 1000;
  let threadId = 9000;
  const transformer = (async (_previous: unknown, method: string, payload: Record<string, unknown>) => {
    const call = { method, payload: { ...payload } };
    calls.push(call);
    const failure = options.fail?.(call);
    if (failure) return failure;
    if (method === 'createForumTopic')
      return { ok: true, result: { message_thread_id: ++threadId, name: payload.name, icon_color: 0 } };
    if (method.startsWith('send') || method === 'editMessageText')
      return {
        ok: true,
        result: {
          message_id: ++messageId,
          date: 0,
          chat: { id: payload.chat_id, type: 'private' },
          text: '',
        },
      };
    return { ok: true, result: true };
  }) as Transformer;
  return {
    transformer,
    calls,
    of: (method: string) => calls.filter((c) => c.method === method),
    last: (method: string) => calls.filter((c) => c.method === method).at(-1),
    clear: () => calls.splice(0),
  };
}
