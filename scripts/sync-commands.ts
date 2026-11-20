import 'dotenv/config';
import { Api } from 'grammy';
import { ADMIN_COMMANDS, botCommands, USER_COMMANDS } from '../src/bot/commands.ts';
import { parseTelegramCliConfig } from '../src/config/env.ts';
import { LANGUAGES } from '../src/domain/i18n.ts';

/**
 * Publishes the command menu from the same registry that renders /help.
 * Public users see user commands; each configured admin additionally sees
 * the admin commands in their private chat (BotCommandScopeChat).
 */
async function main() {
  const api = new Api(parseTelegramCliConfig().BOT_TOKEN);
  const [fallback, ...others] = LANGUAGES;
  await api.setMyCommands(botCommands(fallback, USER_COMMANDS));
  for (const language of [fallback, ...others])
    await api.setMyCommands(botCommands(language, USER_COMMANDS), { language_code: language });

  const admins = (process.env.ADMIN_TELEGRAM_ID ?? '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  for (const chat_id of admins)
    await api.setMyCommands(botCommands(fallback, [...USER_COMMANDS, ...ADMIN_COMMANDS]), {
      scope: { type: 'chat', chat_id },
    });
  console.log(
    `Bot commands synchronized (${LANGUAGES.length} languages, ${admins.length} admin chats).`,
  );
}
main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'Command sync failed');
  process.exitCode = 1;
});
