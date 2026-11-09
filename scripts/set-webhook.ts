import 'dotenv/config';
import { Api } from 'grammy';
import { parseTelegramCliConfig } from '../src/config/env.ts';

async function main() {
  const config = parseTelegramCliConfig();
  if (!config.WEBHOOK_SECRET || config.WEBHOOK_SECRET.length < 24) {
    throw new Error('WEBHOOK_SECRET must be a random value with at least 24 characters');
  }
  const base = process.argv[2] ?? config.PUBLIC_URL;
  if (!base) throw new Error('Provide HTTPS URL as argument, or set PUBLIC_URL in .env');
  const url = new URL(base);
  if (url.protocol !== 'https:') throw new Error('Telegram requires an HTTPS webhook URL');
  const endpoint = new URL(config.WEBHOOK_PATH, url);
  const api = new Api(config.BOT_TOKEN);
  await api.setWebhook(endpoint.toString(), {
    secret_token: config.WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: false,
    max_connections: config.WEBHOOK_MAX_CONNECTIONS,
  });
  console.log(`Webhook registered: ${endpoint.toString()}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
