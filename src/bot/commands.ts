import type { BotCommand } from 'grammy/types';
import { t, type Language, type TranslationKey } from '../domain/i18n.ts';

type CommandSpec = { command: string; description: TranslationKey; args?: string };

/** Single registry for /help and Telegram's command menu (scripts/sync-commands.ts). */
export const USER_COMMANDS: readonly CommandSpec[] = [
  { command: 'start', description: 'cmdStart' },
  { command: 'help', description: 'cmdHelp' },
  { command: 'feedback', description: 'cmdFeedback' },
  { command: 'my_feedbacks', description: 'cmdMyFeedbacks' },
  { command: 'cancel', description: 'cmdCancel' },
  { command: 'settings', description: 'cmdSettings' },
  { command: 'privacy', description: 'cmdPrivacy' },
  { command: 'my_data', description: 'cmdMyData' },
  { command: 'export_my_data', description: 'cmdExportMyData' },
  { command: 'delete_my_data', description: 'cmdDeleteMyData' },
  { command: 'id', description: 'cmdId' },
  { command: 'ping', description: 'cmdPing' },
];

export const ADMIN_COMMANDS: readonly CommandSpec[] = [
  { command: 'tickets', description: 'cmdTickets', args: '[open|in_progress|resolved|closed|all]' },
  { command: 'ticket', description: 'cmdTicket', args: '<#>' },
  { command: 'search', description: 'cmdSearch', args: '<text>' },
  { command: 'reply', description: 'cmdReply', args: '<#> <text>' },
  { command: 'assign', description: 'cmdAssign', args: '<#>' },
  { command: 'resolve', description: 'cmdResolve', args: '<#>' },
  { command: 'close', description: 'cmdClose', args: '<#>' },
  { command: 'reopen', description: 'cmdReopen', args: '<#>' },
  { command: 'set_status', description: 'cmdSetStatus', args: '<#> <status>' },
  { command: 'ban', description: 'cmdBan', args: '<#|userId>' },
  { command: 'unban', description: 'cmdUnban', args: '<#|userId>' },
  { command: 'deliveries', description: 'cmdDeliveries' },
  { command: 'delivery', description: 'cmdDelivery', args: '<id> <action>' },
  { command: 'stats', description: 'cmdStats' },
  { command: 'status', description: 'cmdStatus' },
];

export function botCommands(language: Language, specs: readonly CommandSpec[]): BotCommand[] {
  return specs.map((spec) => ({ command: spec.command, description: t(language, spec.description) }));
}

export function helpText(language: Language, includeAdmin: boolean): string {
  const lines = (specs: readonly CommandSpec[]) =>
    specs
      .map((s) => `/${s.command}${s.args ? ` ${s.args}` : ''} — ${t(language, s.description)}`)
      .join('\n');
  const user = `${t(language, 'helpUser')}\n${lines(USER_COMMANDS)}`;
  return includeAdmin
    ? `${user}\n\n${t(language, 'helpAdmin')}\n${lines(ADMIN_COMMANDS)}\n\n${t(language, 'helpAdminTips')}`
    : user;
}
