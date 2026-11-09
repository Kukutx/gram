import type { Transformer } from 'grammy';

/** Synthetic Telegram transport; fixture responses intentionally cover only called methods. */
export function fakeTelegram(handler: (method: string) => unknown | Promise<unknown>): Transformer {
  return (async (_previous: unknown, method: string) => handler(method)) as Transformer;
}
