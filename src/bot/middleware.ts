import type { Middleware } from 'grammy';
import { getLanguage, touchUser } from '../db/users.ts';
import { normalizeLanguage, translator } from '../domain/i18n.ts';
import { processedUpdates, throttledUpdates, updateDuration } from '../observability/metrics.ts';
import { isPrivacyCallback, isPrivacyCommand } from '../security/rate-limit.ts';
import { callbackData, isPrivateChat, resolveAdmin, type BotContext, type BotDeps } from './context.ts';

/** Metrics and error logging. No update contents (text, usernames) are written to logs. */
export function observe({ logger }: BotDeps): Middleware<BotContext> {
  return async (ctx, next) => {
    const finish = updateDuration.startTimer();
    const updateId = ctx.update.update_id;
    try {
      await next();
      processedUpdates.inc({ result: 'ok' });
      logger.debug({ updateId }, 'Telegram update handled');
    } catch (error) {
      processedUpdates.inc({ result: 'error' });
      logger.error({ err: error, updateId }, 'Telegram update failed');
      throw error;
    } finally {
      finish();
    }
  };
}

/** Cheap, DB-free defaults so every later handler can rely on ctx.lang / ctx.t / ctx.isAdmin. */
export function baseContext({ config }: BotDeps): Middleware<BotContext> {
  return async (ctx, next) => {
    Object.assign(ctx, resolveAdmin(ctx, config));
    ctx.lang = normalizeLanguage(ctx.from?.language_code, config.DEFAULT_LANGUAGE);
    ctx.t = translator(ctx.lang);
    await next();
  };
}

/**
 * Distributed Redis limit, or bounded process-local fallback when Redis is absent.
 * Runs before any database access so floods cannot amplify into DB load.
 * Never blocks requests to erase/export personal data or read the privacy notice.
 */
export function rateLimit({ db, rateLimiter }: BotDeps): Middleware<BotContext> {
  const warned = new Map<number, number>();
  return async (ctx, next) => {
    if (
      !rateLimiter ||
      !isPrivateChat(ctx) ||
      ctx.isAdmin ||
      isPrivacyCommand(ctx.message?.text) ||
      isPrivacyCallback(callbackData(ctx))
    )
      return next();
    const userId = ctx.from!.id;
    if (await rateLimiter.allow(userId)) return next();
    throttledUpdates.inc();
    const now = Date.now();
    if (now - (warned.get(userId) ?? 0) > 60_000) {
      if (warned.size > 20_000) warned.clear();
      warned.set(userId, now);
      await ctx.reply(translator(await getLanguage(db, userId))('rateLimited'));
    }
  };
}

/**
 * Loads the private-chat user once per update and rejects updates whose state
 * change was already committed (Telegram retries after a lost HTTP response).
 * Stale privacy callbacks must not recreate an erased account, so they skip it.
 */
export function userContext({ db }: BotDeps): Middleware<BotContext> {
  return async (ctx, next) => {
    if (!isPrivateChat(ctx) || callbackData(ctx)?.startsWith('erase:')) {
      if (isPrivateChat(ctx)) {
        ctx.lang = await getLanguage(db, ctx.from!.id);
        ctx.t = translator(ctx.lang);
      }
      return next();
    }
    const [receipt, user] = await Promise.all([
      db.commandReceipt.findUnique({
        where: { updateId: ctx.update.update_id },
        select: { updateId: true },
      }),
      touchUser(db, ctx.from!),
    ]);
    ctx.user = user;
    ctx.lang = normalizeLanguage(user.language, ctx.lang);
    ctx.t = translator(ctx.lang);
    if (receipt) {
      await ctx.reply(ctx.t('alreadyHandled'));
      return;
    }
    await next();
  };
}

/**
 * Banned users are ignored silently (no reply that could be farmed for spam),
 * except for privacy commands, which must stay available to everyone.
 */
export function banFilter(): Middleware<BotContext> {
  return async (ctx, next) => {
    if (
      ctx.user?.bannedAt &&
      !isPrivacyCommand(ctx.message?.text) &&
      !isPrivacyCallback(callbackData(ctx))
    )
      return;
    await next();
  };
}
