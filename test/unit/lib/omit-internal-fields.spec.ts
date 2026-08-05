import { describe, expect, it } from 'vitest';

import { omitInternalFields } from '#src/lib/device-message/omit-internal-fields.js';
import type { DeviceMessage } from '#src/lib/device-message/types.js';

describe('omitInternalFields', () => {
  it('omits concurrencyRateLimitKey without mutating the input', () => {
    const message = {
      id: '01ar',
      commandType: 'READ_CREDIT',
      pluginId: 'calin-api-v1',
      priority: 1,
      networkId: null,
      device: { type: 'ELECTRICITY_METER', externalReference: 'm-1' },
      deliveryQueueId: 'ext-1',
      deliveryStatus: 'DELIVERY_SUCCESSFUL',
      concurrencyRateLimitKey: 'rate_limit:calin-api-v1:dcu:7',
      response: { status: 'EXECUTION_SUCCESS', data: { credit: 1 } },
    } as DeviceMessage;

    const payload = omitInternalFields(message);
    expect(payload).not.toHaveProperty('concurrencyRateLimitKey');
    expect(message.concurrencyRateLimitKey).toBe('rate_limit:calin-api-v1:dcu:7');
    expect(payload.response).toEqual(message.response);
  });

  it('returns the same object when concurrencyRateLimitKey is absent', () => {
    const message = {
      id: '01ar',
      commandType: 'READ_CREDIT',
      pluginId: 'stub-push',
      priority: 1,
      networkId: 42,
      device: { type: 'ELECTRICITY_METER', externalReference: 'm-1' },
      deliveryQueueId: '',
      deliveryStatus: 'QUEUED',
    } as DeviceMessage;

    expect(omitInternalFields(message)).toBe(message);
  });
});
