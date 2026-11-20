import Fastify from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { webhookCallback, type Bot } from 'grammy';
import type { AppConfig } from './config/env.ts';
import type { Database } from './db/client.ts';
import type { BotContext } from './bot/create-bot.ts';
import { registry } from './observability/metrics.ts';
import type { Logger } from './observability/logger.ts';
import { operationsHealth } from './observability/operations.ts';
import { operationalMetrics } from './observability/metrics.ts';

export type ServerDeps = {
  config: AppConfig;
  db: Database;
  /** Mounted on WEBHOOK_PATH in webhook mode; omitted for the worker's probe server. */
  bot?: Bot<BotContext>;
  logger: Logger;
};

/** Collapses concurrent/rapid scrapes into one database round of health queries. */
function cached<T>(load: () => Promise<T>, ttlMs: number): () => Promise<T> {
  let value: { at: number; promise: Promise<T> } | undefined;
  return () => {
    if (!value || Date.now() - value.at > ttlMs) {
      const promise = load();
      value = { at: Date.now(), promise };
      promise.catch(() => {
        value = undefined;
      });
    }
    return value.promise;
  };
}

/** Checks untrusted requests before grammY's first getMe() initialization call. */
export function verifyWebhookSecret(header: unknown, expected: string): boolean {
  if (typeof header !== 'string') return false;
  const suppliedBytes = Buffer.from(header, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

/**
 * HTTP surface for every process: liveness/readiness probes, protected operational
 * health and Prometheus metrics, plus the Telegram webhook when a bot runs in webhook mode.
 */
export function createServer({ config, db, bot, logger }: ServerDeps) {
  const webhook = bot !== undefined && config.BOT_MODE === 'webhook';
  if (webhook && !config.WEBHOOK_SECRET) throw new Error('WEBHOOK_SECRET required for HTTP webhook');
  const health = cached(() => operationsHealth(db, config), 5_000);
  const app = Fastify({
    logger: false,
    trustProxy: false,
    bodyLimit: 1_000_000,
    requestTimeout: 15_000,
  });

  app.get('/live', async () => ({ ok: true }));
  app.get('/ready', async (_request, reply) => {
    try {
      await db.$queryRaw`SELECT 1`;
      // Redis is not a critical request dependency: PostgreSQL is the durable outbox.
      // Redis/Worker issues are reported separately and must not take Webhook offline.
      return { ready: true };
    } catch (error) {
      logger.warn({ err: error }, 'Readiness check failed');
      return reply.code(503).send({ ready: false });
    }
  });

  if (config.METRICS_TOKEN) {
    app.get('/ops/health', async (request, reply) => {
      if (!verifyWebhookSecret(request.headers.authorization, `Bearer ${config.METRICS_TOKEN}`))
        return reply.code(401).send({ error: 'unauthorized' });
      const result = await health();
      return reply.code(result.healthy ? 200 : 503).send(result);
    });
    app.get('/metrics', async (request, reply) => {
      if (!verifyWebhookSecret(request.headers.authorization, `Bearer ${config.METRICS_TOKEN}`)) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      // Runtime metrics remain available if operational DB queries fail.
      try {
        const result = await health();
        operationalMetrics.set({ metric: 'worker_required' }, Number(result.workerRequired));
        operationalMetrics.set({ metric: 'worker_fresh' }, Number(result.workerFresh));
        operationalMetrics.set({ metric: 'dispatch_fresh' }, Number(result.dispatchFresh));
        operationalMetrics.set({ metric: 'retention_fresh' }, Number(result.retentionFresh));
        operationalMetrics.set({ metric: 'pending' }, result.pending + result.pendingReplies);
        operationalMetrics.set({ metric: 'blocked' }, result.blocked + result.blockedReplies);
        operationalMetrics.set(
          { metric: 'oldest_pending_seconds' },
          result.oldestPendingAgeSeconds ?? 0,
        );
        operationalMetrics.set({ metric: 'retention_overdue_seconds' }, result.retentionOverdueSeconds);
        operationalMetrics.set({ metric: 'database_query_ok' }, 1);
      } catch {
        operationalMetrics.set({ metric: 'database_query_ok' }, 0);
      }
      return reply.header('Content-Type', registry.contentType).send(await registry.metrics());
    });
  }

  // Fastify rejects unauthorized requests BEFORE grammY initializes the bot
  // (which otherwise may contact Telegram getMe on a fresh instance).
  // grammY independently rechecks the same secret before dispatching updates.
  if (webhook)
    app.post(
      config.WEBHOOK_PATH,
      {
        onRequest: async (request, reply) => {
          if (
            !verifyWebhookSecret(
              request.headers['x-telegram-bot-api-secret-token'],
              config.WEBHOOK_SECRET!,
            )
          ) {
            return reply.code(401).send({ error: 'unauthorized' });
          }
        },
      },
      webhookCallback(bot!, 'fastify', {
        secretToken: config.WEBHOOK_SECRET,
        timeoutMilliseconds: 9_500,
        onTimeout: 'throw',
      }),
    );

  app.setErrorHandler((error, request, reply) => {
    logger.error({ err: error, route: request.routeOptions.url }, 'HTTP request failed');
    const status =
      error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
    reply.code(typeof status === 'number' && status >= 400 && status <= 599 ? status : 500).send({
      error: 'request_failed',
    });
  });

  return app;
}
