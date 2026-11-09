import 'dotenv/config';
import { Api } from 'grammy';
import { Redis } from 'ioredis';
import { parseConfig } from '../src/config/env.ts';
import { createPrisma } from '../src/db/client.ts';

async function main(): Promise<void> {
  const config = parseConfig();
  let issues = 0;
  const check = (label: string, success: boolean, extra = '') => {
    console.log(`${success ? 'PASS' : 'FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
    if (!success) issues++;
  };

  check(
    'Node.js 24 LTS',
    Number(process.versions.node.split('.')[0]) === 24,
    `running ${process.version}`,
  );
  check('Mode', true, config.BOT_MODE);

  const db = createPrisma(config);
  try {
    await db.$queryRaw`SELECT 1`;
    check('PostgreSQL connection', true);
  } catch {
    check('PostgreSQL connection', false);
  } finally {
    await db.$disconnect();
  }

  if (config.REDIS_URL) {
    const redis = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      connectTimeout: 4_000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    redis.on('error', () => {}); // Connectivity report is deliberately one-line and credential-free.
    try {
      await redis.connect();
      check('Redis connection', (await redis.ping()) === 'PONG');
      // Memorystore blocks CONFIG; INFO memory is supported and includes maxmemory_policy.
      const memory = await redis.info('memory');
      const policy = /^maxmemory_policy:([^\r\n]+)/m.exec(memory)?.[1];
      check(
        'Redis noeviction policy (required by BullMQ)',
        policy === 'noeviction',
        policy ? `observed ${policy}` : 'policy field unavailable; verify via gcloud',
      );
    } catch {
      check('Redis connection', false);
    } finally {
      redis.disconnect();
    }
  } else {
    console.log('SKIP Redis (notifications are disabled)');
  }

  const api = new Api(config.BOT_TOKEN);
  try {
    const user = await api.getMe();
    check('Telegram Bot API', true, `@${user.username}`);
    const webhook = await api.getWebhookInfo();
    const active = Boolean(webhook.url);
    check(
      'Telegram update mode',
      config.BOT_MODE === 'webhook' ? active : !active,
      active ? 'webhook is registered' : 'no webhook registered',
    );
    if (active) console.log(`INFO Webhook pending updates: ${webhook.pending_update_count}`);
  } catch {
    check('Telegram Bot API', false);
  }

  if (issues > 0) process.exitCode = 1;
  console.log(`Diagnostics completed: ${issues} failing check(s). No secrets were printed.`);
}

main().catch((error: unknown) => {
  console.error(
    'Diagnostics could not start:',
    error instanceof Error ? error.message : 'unknown error',
  );
  process.exitCode = 1;
});
