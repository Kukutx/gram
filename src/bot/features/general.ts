import { Composer } from 'grammy';
import { Menu } from '@grammyjs/menu';
import { setLanguage } from '../../db/users.ts';
import { LANGUAGES, LANGUAGE_LABELS, t } from '../../domain/i18n.ts';
import { helpText } from '../commands.ts';
import { isPrivateChat, type BotContext, type BotDeps } from '../context.ts';

export function generalFeature({ config, db }: BotDeps): Composer<BotContext> {
  const composer = new Composer<BotContext>();

  const languageMenu = new Menu<BotContext>('language-settings');
  LANGUAGES.forEach((language, index) => {
    if (index > 0) languageMenu.row();
    // The current choice is ticked, so the menu also answers "which language is set?".
    const label = (ctx: BotContext) =>
      `${LANGUAGE_LABELS[language]}${ctx.lang === language ? ' ✓' : ''}`;
    languageMenu.text(label, async (ctx) => {
      if (!ctx.from || !isPrivateChat(ctx)) return;
      await setLanguage(db, ctx.from.id, language, ctx.update.update_id);
      ctx.menu.close();
      await ctx.reply(t(language, 'languageSaved'));
    });
  });
  composer.use(languageMenu);

  composer.command('start', (ctx) =>
    ctx.reply(ctx.t(config.INTAKE_MODE === 'direct' ? 'welcomeDirect' : 'welcome')),
  );
  composer.command('help', (ctx) => ctx.reply(helpText(ctx.lang, ctx.isAdmin)));
  composer.command('ping', (ctx) => ctx.reply(ctx.t('ping')));
  composer.command('id', (ctx) =>
    ctx.reply(ctx.t('id', { userId: ctx.from?.id ?? 'unknown', chatId: ctx.chat.id })),
  );
  composer.command('settings', async (ctx) => {
    if (!isPrivateChat(ctx)) return ctx.reply(ctx.t('privateOnly'));
    await ctx.reply(ctx.t('settings'), { reply_markup: languageMenu });
  });
  composer.command('privacy', async (ctx) => {
    const retention =
      config.FEEDBACK_RETENTION_DAYS > 0
        ? ctx.t('retentionEnabled', { days: config.FEEDBACK_RETENTION_DAYS })
        : ctx.t('retentionDisabled');
    const contact = ctx.t('privacyContact', { contact: config.SUPPORT_CONTACT ?? '/feedback' });
    const policy = config.PRIVACY_POLICY_URL ? `\n${config.PRIVACY_POLICY_URL}` : '';
    await ctx.reply(
      `${ctx.t('privacy')}\n\n${retention}\n${ctx.t('privacyCopies')}\n${contact}${policy}`,
      {
        link_preview_options: { is_disabled: true },
      },
    );
  });

  return composer;
}
