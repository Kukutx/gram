import 'dotenv/config';
import { Api } from 'grammy';
import { Redis } from 'ioredis';
import { hasSupportTeam, parseConfig } from '../src/config/env.ts';
import { createPrisma } from '../src/db/client.ts';

/**
 * Pre-flight and post-deploy self-check. Prints one line per check and never
 * prints secrets, so the output can be pasted into an issue or chat.
 */
async function main(): Promise<void> {
  const config = parseConfig();
  let issues = 0;
  const check = (label: string, success: boolean, extra = '') => {
    console.log(`${success ? 'PASS' : 'FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
    if (!success) issues++;
  };
  const warn = (label: string, extra: string) => console.log(`WARN ${label} — ${extra}`);

  check(
    'Node.js 24 LTS',
    Number(process.versions.node.split('.')[0]) === 24,
    `running ${process.version}`,
  );
  check('Mode', true, `${config.BOT_MODE}, intake ${config.INTAKE_MODE}`);
  if (!hasSupportTeam(config))
    warn(
      'Support team',
      'neither ADMIN_IDS nor ADMIN_CHAT_ID is set; tickets are stored but nobody is notified',
    );

  const db = createPrisma(config);
  try {
    await db.$queryRaw`SELECT 1`;
    check('PostgreSQL connection', true);
    const migrations = await db.$queryRaw<{ pending: bigint }[]>`
      SELECT count(*) AS pending FROM "_prisma_migrations" WHERE "finished_at" IS NULL OR "rolled_back_at" IS NOT NULL`;
    check('Migrations applied cleanly', Number(migrations[0]?.pending ?? 0) === 0);
    const trigger = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_trigger WHERE tgname = 'Delivery_notify_insert'`;
    check(
      'Outbox NOTIFY trigger',
      Number(trigger[0]?.n ?? 0) === 1,
      'worker wakes instantly on new messages',
    );
  } catch {
    check('PostgreSQL schema', false, 'run `pnpm db:deploy` (prisma migrate deploy) first');
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
      check('Redis connection (shared rate limit)', (await redis.ping()) === 'PONG');
    } catch {
      check('Redis connection (shared rate limit)', false);
    } finally {
      redis.disconnect();
    }
  } else {
    console.log('SKIP Redis (rate limiting is per process)');
  }

  const api = new Api(config.BOT_TOKEN);
  try {
    const me = await api.getMe();
    check('Telegram Bot API', true, `@${me.username}`);
    const webhook = await api.getWebhookInfo();
    const active = Boolean(webhook.url);
    check(
      'Telegram update mode',
      config.BOT_MODE === 'webhook' ? active : !active,
      active ? 'webhook is registered' : 'no webhook registered',
    );
    if (active) console.log(`INFO Webhook pending updates: ${webhook.pending_update_count}`);
    if (webhook.last_error_message) warn('Webhook last error', webhook.last_error_message);

    if (config.ADMIN_CHAT_ID !== undefined) {
      try {
        const chat = await api.getChat(config.ADMIN_CHAT_ID);
        check('Support group reachable', true, chat.type);
        const member = await api.getChatMember(config.ADMIN_CHAT_ID, me.id);
        const isAdmin = member.status === 'administrator';
        // Without admin rights (or with privacy mode on) the bot cannot see plain replies in the group.
        check(
          'Bot is a group administrator',
          isAdmin,
          isAdmin ? '' : 'promote the bot so it receives every message',
        );
        if (config.ADMIN_USE_TOPICS) {
          const forum = chat.type === 'supergroup' && 'is_forum' in chat && chat.is_forum === true;
          check('Group has topics enabled', forum);
          check(
            'Bot can manage topics',
            member.status === 'administrator' && member.can_manage_topics === true,
          );
        }
      } catch {
        check(
          'Support group reachable',
          false,
          'add the bot to ADMIN_CHAT_ID and check the ID (use /id there)',
        );
      }
    }
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
