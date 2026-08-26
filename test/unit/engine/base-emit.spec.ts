import { describe, expect, it, vi } from 'vitest';

import { deviceMessagingConfigSchema } from '#src/config/schema.js';
import { createBaseService } from '#src/engine/base.js';
import type { StageMoves } from '#src/engine/lifecycle/moves.js';
import type { MessageStore } from '#src/lib/redis-repository/message-store.js';
import { STUB_PUSH_ID } from '#src/plugins/stub/index.js';
import { noopMetrics } from '../../helpers/noop-metrics.js';

const delivery = deviceMessagingConfigSchema.parse({ $schemaVersion: '1' }).delivery;

const unused = (): never => {
  throw new Error('unused');
};

/** Emit-only specs do not hit Redis; the message store and moves are required on the factory. */
const unusedMessageStore: MessageStore = {
  enqueueDeviceMessage: unused,
  getMessageById: async () => null,
  getMessageFromCorrelationId: async () => null,
  getAllMessagesForCorrelationId: async () => [],
  getMessageIdFromDeliveryQueueId: async () => undefined,
};

const unusedMoves: StageMoves = {
  pickIntoNs: unused,
  advance: unused,
  enterRetry: unused,
  reschedule: unused,
  purge: unused,
  listReadyQueues: unused,
  claimFromQueue: unused,
  requeue: unused,
};

describe('createBaseService emitDeliveryEvent', () => {
  it('awaits webhook.storeAndEmit when wired', async () => {
    const storeAndEmit = vi.fn(async () => undefined);
    const baseService = createBaseService({
      delivery,
      webhook: { storeAndEmit },
      messageStore: unusedMessageStore,
      moves: unusedMoves,
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
      moves: unusedMoves,
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
