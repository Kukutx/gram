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
  { command: 'export_my_replies', description: 'cmdExportMyReplies' },
  { command: 'delete_my_data', description: 'cmdDeleteMyData' },
  { command: 'id', description: 'cmdId' },
  { command: 'ping', description: 'cmdPing' },
];

export const ADMIN_COMMANDS: readonly CommandSpec[] = [
  { command: 'feedbacks', description: 'cmdFeedbacks' },
  { command: 'ticket', description: 'cmdTicket', args: '<id>' },
  { command: 'assign', description: 'cmdAssign', args: '<id>' },
  { command: 'reply', description: 'cmdReply', args: '<id> <text>' },
  { command: 'resolve', description: 'cmdResolve', args: '<id>' },
  { command: 'close', description: 'cmdClose', args: '<id>' },
  { command: 'reopen', description: 'cmdReopen', args: '<id>' },
  { command: 'set_status', description: 'cmdSetStatus', args: '<id> <status>' },
  { command: 'deliveries', description: 'cmdDeliveries' },
  { command: 'delivery', description: 'cmdDelivery', args: '<kind> <id> <action>' },
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
  return includeAdmin ? `${user}\n\n${t(language, 'helpAdmin')}\n${lines(ADMIN_COMMANDS)}` : user;
}
