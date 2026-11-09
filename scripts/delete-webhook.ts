import 'dotenv/config';
import { Api } from 'grammy';
import { parseTelegramCliConfig } from '../src/config/env.ts';

async function main() {
  const config = parseTelegramCliConfig();
  await new Api(config.BOT_TOKEN).deleteWebhook({ drop_pending_updates: false });
  console.log('Webhook deleted; pending updates preserved.');
}
main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
