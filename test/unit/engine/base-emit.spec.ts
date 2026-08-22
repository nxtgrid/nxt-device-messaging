import { describe, expect, it, vi } from 'vitest';

import { deviceMessagingConfigSchema } from '#src/config/schema.js';
import { createBaseService } from '#src/engine/base.js';
import type { MessageStore } from '#src/lib/redis-repository/message-store.js';
import type { StageStore } from '#src/lib/redis-repository/stage-store.js';
import { STUB_PUSH_ID } from '#src/plugins/stub/index.js';
import { noopMetrics } from '../../helpers/noop-metrics.js';

const delivery = deviceMessagingConfigSchema.parse({ $schemaVersion: '1' }).delivery;

const unused = (): never => {
  throw new Error('unused');
};

/** Emit-only specs do not hit Redis; the stores are required on the factory. */
const unusedMessageStore: MessageStore = {
  enqueueDeviceMessage: unused,
  getMessageById: async () => null,
  getMessageFromCorrelationId: async () => null,
  getAllMessagesForCorrelationId: async () => [],
  getMessageIdFromDeliveryQueueId: async () => undefined,
};

const unusedStageStore: StageStore = {
  moveMessageBetweenQueues: unused,
  fetchNextMessageInQueueAndMove: unused,
  getExpiredMessagesInQueue: unused,
  removeMessageFromQueue: unused,
  requeueMessage: unused,
  messageFullCleanup: unused,
  fetchQueuesWithMessages: unused,
  zscore: unused,
  hmget: unused,
  zaddXx: unused,
  multi: unused,
};

describe('createBaseService emitDeliveryEvent', () => {
  it('awaits webhook.storeAndEmit when wired', async () => {
    const storeAndEmit = vi.fn(async () => undefined);
    const baseService = createBaseService({
      delivery,
      webhook: { storeAndEmit },
      messageStore: unusedMessageStore,
      stageStore: unusedStageStore,
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
      delivery,
      messageStore: unusedMessageStore,
      stageStore: unusedStageStore,
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
