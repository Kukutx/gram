import { collectDefaultMetrics, Counter, Histogram, Registry, Gauge } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'grammy_bot_' });
export const operationalMetrics = new Gauge({
  name: 'grammy_bot_operations',
  help: 'Operational database health and delivery metrics',
  labelNames: ['metric'] as const,
  registers: [registry],
});

export const processedUpdates = new Counter({
  name: 'grammy_bot_updates_total',
  help: 'Number of updates processed by the grammY handler',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const updateDuration = new Histogram({
  name: 'grammy_bot_update_duration_seconds',
  help: 'End-to-end processing time of a Telegram update',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

/** Outbox send attempts by outcome (sent, retry, blocked, gone, lost_lease, error). */
export const deliveryOutcomes = new Counter({
  name: 'grammy_bot_delivery_outcomes_total',
  help: 'Outbox delivery attempts by outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const throttledUpdates = new Counter({
  name: 'grammy_bot_throttled_updates_total',
  help: 'Telegram updates dropped by the per-user application rate limit',
  registers: [registry],
});
