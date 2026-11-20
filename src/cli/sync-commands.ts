import 'dotenv/config';
import { Api } from 'grammy';
import { ADMIN_COMMANDS, botCommands, USER_COMMANDS } from '../bot/commands.ts';
import { parseTelegramCliConfig } from '../config/env.ts';
import { LANGUAGES } from '../domain/i18n.ts';

/**
 * Publishes the command menu from the same registry that renders /help.
 * Public users see user commands; each admin (ADMIN_IDS) additionally sees the
 * admin commands in their private chat, and the support group (ADMIN_CHAT_ID)
 * gets the admin commands for everyone in it.
 */
async function main() {
  const config = parseTelegramCliConfig();
  const api = new Api(config.BOT_TOKEN);
  const [fallback, ...others] = LANGUAGES;
  const all = (language: (typeof LANGUAGES)[number]) =>
    botCommands(language, [...USER_COMMANDS, ...ADMIN_COMMANDS]);
  await api.setMyCommands(botCommands(fallback, USER_COMMANDS));
  for (const language of [fallback, ...others]) {
    await api.setMyCommands(botCommands(language, USER_COMMANDS), { language_code: language });
    for (const chat_id of config.ADMIN_IDS)
      await api.setMyCommands(all(language), {
        scope: { type: 'chat', chat_id },
        language_code: language,
      });
    if (config.ADMIN_CHAT_ID !== undefined)
      await api.setMyCommands(botCommands(language, ADMIN_COMMANDS), {
        scope: { type: 'chat', chat_id: config.ADMIN_CHAT_ID },
        language_code: language,
      });
  }
  // Scoped menus without a language code act as the fallback for other client languages.
  for (const chat_id of config.ADMIN_IDS)
    await api.setMyCommands(all(fallback), { scope: { type: 'chat', chat_id } });
  if (config.ADMIN_CHAT_ID !== undefined)
    await api.setMyCommands(botCommands(fallback, ADMIN_COMMANDS), {
      scope: { type: 'chat', chat_id: config.ADMIN_CHAT_ID },
    });
  console.log(
    `Bot commands synchronized (${LANGUAGES.length} languages, ${config.ADMIN_IDS.length} admin chats` +
      `${config.ADMIN_CHAT_ID !== undefined ? ', 1 support group' : ''}).`,
  );
}
main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'Command sync failed');
  process.exitCode = 1;
});
