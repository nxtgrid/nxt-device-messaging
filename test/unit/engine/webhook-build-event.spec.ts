import { describe, expect, it } from 'vitest';

import { buildWebhookEvent } from '#src/engine/webhook/build-event.js';
import type { DeviceMessage } from '#src/lib/device-message/types.js';

const BASE: Partial<DeviceMessage> = {
  pluginId: 'stub-push',
  deliveryStatus: 'SENT_TO_NS',
  device: {
    type: 'ELECTRICITY_METER',
    externalReference: 'm-1',
  },
  id: '01MSG',
  correlationId: 'corr-1',
  commandType: 'READ_CREDIT',
  concurrencyRateLimitKey: 'rate_limit:should-strip',
};

describe('buildWebhookEvent', () => {
  it('builds a WebhookEvent and strips internal fields', () => {
    const result = buildWebhookEvent(BASE, '2026-08-10T12:00:00.000Z', '01EVENT');

    expect(result).toEqual({
      ok: true,
      event: {
        eventId: '01EVENT',
        occurredAt: '2026-08-10T12:00:00.000Z',
        pluginId: 'stub-push',
        message: {
          id: '01MSG',
          correlationId: 'corr-1',
          commandType: 'READ_CREDIT',
          deliveryStatus: 'SENT_TO_NS',
          device: BASE.device,
        },
      },
    });
    if (result.ok) {
      expect(result.event.message).not.toHaveProperty('concurrencyRateLimitKey');
    }
  });

  it('rejects when required fields are missing', () => {
    expect(buildWebhookEvent({ ...BASE, pluginId: undefined }).ok).toBe(false);
    expect(buildWebhookEvent({ ...BASE, deliveryStatus: undefined }).ok).toBe(false);
    expect(buildWebhookEvent({ ...BASE, device: undefined }).ok).toBe(false);
  });
});
