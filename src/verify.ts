import 'dotenv/config';
import { Api } from 'grammy';
import { parseConfig } from './config/env.ts';
import { createPrisma } from './db/client.ts';
import { operationsHealth } from './observability/operations.ts';

const config = parseConfig();
const db = createPrisma(config);
try {
  const api = new Api(config.BOT_TOKEN, { timeoutSeconds: 8 });
  await api.getMe();
  const info = await api.getWebhookInfo();
  const expected = config.PUBLIC_URL
    ? new URL(config.WEBHOOK_PATH, config.PUBLIC_URL).toString()
    : undefined;
  const bootstrap = process.env.ALLOW_UNREGISTERED_WEBHOOK === '1';
  if (!expected || (!bootstrap && info.url !== expected) || (info.url && info.url !== expected))
    throw new Error('Webhook verification failed');
  let healthy = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const health = await operationsHealth(db, config);
    if (health.healthy) {
      healthy = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (!healthy) throw new Error('Worker or maintenance verification failed');
  if (!config.PUBLIC_URL || !config.METRICS_TOKEN) throw new Error('Verification configuration missing');
  for (const path of ['/ready', '/ops/health']) {
    const result = await fetch(new URL(path, config.PUBLIC_URL), {
      headers: { authorization: `Bearer ${config.METRICS_TOKEN}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!result.ok) throw new Error('HTTP health verification failed');
  }
  console.log(
    bootstrap
      ? 'Bootstrap checks passed; webhook registration still required.'
      : 'Deployment health and webhook checks passed.',
  );
} catch {
  console.error(
    'Deployment verification failed. Check webhook configuration, Worker heartbeat, blocked deliveries and database health.',
  );
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
