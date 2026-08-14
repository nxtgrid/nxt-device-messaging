import { describe, expect, it, vi } from 'vitest';

import { createBaseService } from '#src/engine/base.js';
import { deviceMessagingConfigSchema } from '#src/config/schema.js';
import { createPluginRegistry } from '#src/plugins/registry.js';
import { STUB_PUSH_ID } from '#src/plugins/stub/index.js';
import { noopMetrics } from '../../helpers/noop-metrics.js';

const delivery = deviceMessagingConfigSchema.parse({ $schemaVersion: '1' }).delivery;

describe('createBaseService emitDeliveryEvent', () => {
  it('awaits webhook.storeAndEmit when wired', async () => {
    const storeAndEmit = vi.fn(async () => undefined);
    const baseService = createBaseService({
      registry: createPluginRegistry([ { id: STUB_PUSH_ID } ]),
      delivery,
      webhook: { storeAndEmit },
      metrics: noopMetrics,
    });

    const message = {
      pluginId: STUB_PUSH_ID,
      deliveryStatus: 'SENT_TO_NS' as const,
      device: { type: 'ELECTRICITY_METER' as const, externalReference: 'm-1' },
    };

    await baseService.emitDeliveryEvent(message);

    expect(storeAndEmit).toHaveBeenCalledWith(message);
  });

  it('is a no-op when no webhook is configured', async () => {
    const baseService = createBaseService({
      registry: createPluginRegistry([ { id: STUB_PUSH_ID } ]),
      delivery,
      metrics: noopMetrics,
    });

    await expect(
      baseService.emitDeliveryEvent({
        pluginId: STUB_PUSH_ID,
        deliveryStatus: 'SENT_TO_NS',
        device: { type: 'ELECTRICITY_METER', externalReference: 'm-1' },
      }),
    ).resolves.toBeUndefined();
  });
});
