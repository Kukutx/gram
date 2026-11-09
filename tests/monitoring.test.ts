import { describe, expect, it } from 'vitest';
import { sanitizeMonitoringEvent } from '../src/observability/errors.ts';

describe('telemetry privacy', () => {
  it('drops requests, exceptions, users, tags, contexts, breadcrumbs and raw messages', () => {
    const result = sanitizeMonitoringEvent({
      type: undefined,
      event_id: 'safe-id',
      message: 'PRIVATE',
      request: { data: 'PRIVATE' },
      user: { id: 'PRIVATE' },
      tags: { token: 'PRIVATE' },
      exception: { values: [{ value: 'PRIVATE' }] },
      breadcrumbs: [{ message: 'PRIVATE' }],
      contexts: { payload: { text: 'PRIVATE' } },
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(result.event_id).toBe('safe-id');
  });
});
