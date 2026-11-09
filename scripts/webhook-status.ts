import 'dotenv/config';
import { Api } from 'grammy';
import { parseTelegramCliConfig } from '../src/config/env.ts';

async function main(): Promise<void> {
  const { BOT_TOKEN } = parseTelegramCliConfig();
  const info = await new Api(BOT_TOKEN).getWebhookInfo();
  // No bot token, update payloads, or secrets are printed.
  console.log(
    JSON.stringify(
      {
        configured: Boolean(info.url),
        url: info.url || null,
        pendingUpdates: info.pending_update_count,
        lastErrorDate: info.last_error_date ?? null,
        lastErrorMessage: info.last_error_message ?? null,
        maxConnections: info.max_connections ?? null,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(
    'Unable to read Telegram webhook status:',
    error instanceof Error ? error.message : 'unknown error',
  );
  process.exitCode = 1;
});
