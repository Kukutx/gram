import type { Context } from 'grammy';
import type { MenuFlavor } from '@grammyjs/menu';
import type { AppConfig } from '../config/env.ts';
import type { Database } from '../db/client.ts';
import type { UserSnapshot } from '../db/users.ts';
import type { Language, Translator } from '../domain/i18n.ts';
import type { Logger } from '../observability/logger.ts';
import type { RateLimiter } from '../security/rate-limit.ts';

/** Per-update state resolved once by middleware, so handlers never re-query it. */
export type AppFlavor = {
  /** Present for private chats after the user middleware ran (absent for erase callbacks). */
  user?: UserSnapshot;
  lang: Language;
  t: Translator;
  /** A configured admin in private chat, or any member of the support group. */
  isAdmin: boolean;
  /** The update comes from the configured support group. */
  inSupportChat: boolean;
};

export type BotContext = Context & MenuFlavor & AppFlavor;

export type BotDeps = {
  config: AppConfig;
  db: Database;
  rateLimiter?: RateLimiter;
  logger: Logger;
};

export function isPrivateChat(ctx: Context): boolean {
  return ctx.chat?.type === 'private' && ctx.from !== undefined;
}

export function callbackData(ctx: Context): string | undefined {
  return ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
}

/**
 * Trust model: ADMIN_IDS are admins in their private chat with the bot. Inside the
 * configured support group, every human member is staff: only add trusted people.
 */
export function resolveAdmin(ctx: Context, config: Pick<AppConfig, 'ADMIN_IDS' | 'ADMIN_CHAT_ID'>) {
  const inSupportChat = config.ADMIN_CHAT_ID !== undefined && ctx.chat?.id === config.ADMIN_CHAT_ID;
  const human = ctx.from !== undefined && !ctx.from.is_bot;
  const isAdmin =
    human && ((isPrivateChat(ctx) && config.ADMIN_IDS.includes(ctx.from!.id)) || inSupportChat);
  return { isAdmin, inSupportChat };
}
