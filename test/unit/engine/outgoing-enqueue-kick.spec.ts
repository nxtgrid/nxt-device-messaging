import { describe, expect, it, vi } from 'vitest';

import { deviceMessagingConfigSchema } from '#src/config/schema.js';
import type { BaseService } from '#src/engine/base.js';
import { createInFlightSends } from '#src/engine/in-flight-sends.js';
import type { StageMoves } from '#src/engine/lifecycle/moves.js';
import { createOutgoingService } from '#src/engine/outgoing.js';
import type { CreateDeviceMessage, DeviceMessage } from '#src/lib/device-message/types.js';
import type { AdmissionStore } from '#src/lib/redis-repository/admission-store.js';
import type { MessageStore } from '#src/lib/redis-repository/message-store.js';
import { createPluginRegistry } from '#src/plugins/registry.js';
import { STUB_PUSH_ID } from '#src/plugins/stub/index.js';
import { noopMetrics } from '../../helpers/noop-metrics.js';

const delivery = deviceMessagingConfigSchema.parse({ $schemaVersion: '1' }).delivery;

const create: CreateDeviceMessage = {
  commandType: 'READ_CREDIT',
  priority: 1,
  pluginId: STUB_PUSH_ID,
  networkId: 1,
  device: { type: 'ELECTRICITY_METER', externalReference: 'm-1' },
};

function queued(dto: CreateDeviceMessage, id: string): DeviceMessage {
  return {
    ...dto,
    id,
    deliveryQueueId: '',
    deliveryStatus: 'QUEUED',
    retryCount: 0,
    failureHistory: [],
  };
}

describe('stopEnqueueKick', () => {
  it('still stores after stop, and does not start distribute', async () => {
    const listReadyQueues = vi.fn(async () => []);
    let stored = 0;

    const outgoing = createOutgoingService({
      registry: createPluginRegistry([ { id: STUB_PUSH_ID } ]),
      delivery,
      baseService: {} as BaseService,
      inFlightSends: createInFlightSends(),
      engineEnabled: true,
      admissionStore: {} as AdmissionStore,
      messageStore: {
        enqueueDeviceMessage: async (dto: CreateDeviceMessage) => {
          stored += 1;
          return queued(dto, `msg-${ stored }`);
        },
      } as unknown as MessageStore,
      moves: { listReadyQueues } as unknown as StageMoves,
      metrics: noopMetrics,
    });

    await outgoing.enqueue(create);
    await vi.waitFor(() => {
      expect(listReadyQueues).toHaveBeenCalled();
    });

    outgoing.stopEnqueueKick();
    listReadyQueues.mockClear();

    const second = await outgoing.enqueue(create);
    await new Promise<void>(resolve => {
      setTimeout(resolve, 30);
    });

    expect(second.deliveryStatus).toBe('QUEUED');
    expect(stored).toBe(2);
    expect(listReadyQueues).not.toHaveBeenCalled();
  });
});
