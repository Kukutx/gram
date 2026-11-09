import * as Sentry from '@sentry/node';
import type { AppConfig } from '../config/env.ts';
import { safeError } from './logger.ts';

export function sanitizeMonitoringEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  return {
    type: event.type,
    event_id: event.event_id,
    timestamp: event.timestamp,
    level: event.level,
    platform: 'node',
    message: 'Bot operation failed',
  };
}

export function initMonitoring(config: AppConfig): void {
  if (!config.SENTRY_DSN) return;
  Sentry.init({
    dsn: config.SENTRY_DSN,
    sendDefaultPii: false,
    beforeSend: sanitizeMonitoringEvent,
  });
}

export function reportError(error: unknown): void {
  const safe = safeError(error);
  Sentry.captureMessage(`Bot operation failed: ${safe.type}`, {
    level: 'error',
    tags: { errorType: safe.type, ...(safe.code !== undefined ? { errorCode: String(safe.code) } : {}) },
  });
}
