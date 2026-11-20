import type { AppConfig } from '../config/env.ts';
import type { Recipient, StatusNotice } from '../db/tickets.ts';
import { normalizeLanguage, t } from '../domain/i18n.ts';

/**
 * Who is notified about user messages: the support group when configured
 * (topics are resolved at send time), otherwise every admin privately.
 */
export function adminRecipients(config: Pick<AppConfig, 'ADMIN_CHAT_ID' | 'ADMIN_IDS'>): Recipient[] {
  if (config.ADMIN_CHAT_ID !== undefined) return [{ chatId: config.ADMIN_CHAT_ID }];
  return config.ADMIN_IDS.map((chatId) => ({ chatId }));
}

/** Builds the localized "ticket resolved/closed/reopened" notice, or nothing when disabled. */
export function statusNotice(
  config: Pick<AppConfig, 'NOTIFY_USER_ON_STATUS' | 'DEFAULT_LANGUAGE'>,
): StatusNotice | undefined {
  if (!config.NOTIFY_USER_ON_STATUS) return undefined;
  const keys = {
    resolved: 'statusNoticeResolved',
    closed: 'statusNoticeClosed',
    open: 'statusNoticeReopened',
  } as const;
  return (language, number, status) => {
    const key = keys[status as keyof typeof keys];
    return key ? t(normalizeLanguage(language, config.DEFAULT_LANGUAGE), key, { number }) : null;
  };
}
