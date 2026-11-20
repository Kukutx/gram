import { Bot } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { reportError } from '../observability/errors.ts';
import type { BotContext, BotDeps } from './context.ts';
import { adminFeature } from './features/admin.ts';
import { feedbackFeature } from './features/feedback.ts';
import { generalFeature } from './features/general.ts';
import { privacyFeature } from './features/privacy.ts';
import { baseContext, observe, rateLimit, userContext } from './middleware.ts';

export type { BotContext, BotDeps } from './context.ts';

/**
 * Builds the single grammY Bot for the process. Middleware order matters:
 * metrics → cheap context → rate limit (before any DB access) → user/receipt
 * loading → features. The feedback feature goes last because it owns the
 * catch-all text handler.
 */
export function createBot(deps: BotDeps): Bot<BotContext> {
  const { config, logger } = deps;
  const bot = new Bot<BotContext>(config.BOT_TOKEN, {
    // Long polling holds getUpdates open; webhook-mode API calls should fail fast.
    client: { timeoutSeconds: config.BOT_MODE === 'polling' ? 60 : 8 },
  });
  bot.api.config.use(autoRetry({ maxRetryAttempts: 2, maxDelaySeconds: 5 }));

  bot.use(observe(deps), baseContext(deps), rateLimit(deps), userContext(deps));
  bot.use(generalFeature(deps), privacyFeature(deps), adminFeature(deps), feedbackFeature(deps));

  /**
   * Only long polling reaches this handler (webhook mode surfaces errors as HTTP 5xx so
   * Telegram retries). It must not rethrow: grammY would stop polling and the process would
   * exit on a single transient failure. The update is logged and skipped instead.
   */
  bot.catch((error) => {
    logger.error(
      { err: error.error, updateId: error.ctx.update.update_id },
      'Update skipped after error',
    );
    reportError(error.error);
  });

  return bot;
}
