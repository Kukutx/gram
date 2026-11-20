import type { Context } from 'grammy';
import type { MenuFlavor } from '@grammyjs/menu';
import type { AppConfig } from '../config/env.ts';
import type { Database } from '../db/client.ts';
import type { UserSnapshot } from '../db/repository.ts';
import type { Language, Translator } from '../domain/i18n.ts';
import type { Logger } from '../observability/logger.ts';
import type { Notifications } from '../queue/notifications.ts';
import type { RateLimiter } from '../security/rate-limit.ts';

/** Per-update state resolved once by middleware, so handlers never re-query it. */
export type AppFlavor = {
  /** Present for private chats after the user middleware ran (absent for erase callbacks). */
  user?: UserSnapshot;
  lang: Language;
  t: Translator;
  isAdmin: boolean;
};

export type BotContext = Context & MenuFlavor & AppFlavor;

export type BotDeps = {
  config: AppConfig;
  db: Database;
  notifications?: Notifications;
  rateLimiter?: RateLimiter;
  logger: Logger;
};

export function isPrivateChat(ctx: Context): boolean {
  return ctx.chat?.type === 'private' && ctx.from !== undefined;
}

export function adminIds(config: Pick<AppConfig, 'ADMIN_TELEGRAM_ID'>): ReadonlySet<number> {
  return new Set(config.ADMIN_TELEGRAM_ID ? [Number(config.ADMIN_TELEGRAM_ID)] : []);
}

export function callbackData(ctx: Context): string | undefined {
  return ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
}
