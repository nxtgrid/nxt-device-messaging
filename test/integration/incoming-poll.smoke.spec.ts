/**
 * Real createIncomingService.pollPullPlugins smoke (Unit 5.5 Step B):
 * enqueue → distribute → sendOne → awaiting-task → poll tick → cleanup.
 *
 * Opt-in (needs Valkey):
 *
 *   docker compose up -d valkey
 *   RUN_REDIS_SMOKE=1 pnpm exec vitest run test/integration/incoming-poll.smoke.spec.ts
 */
import { afterAll, describe, expect, it } from 'vitest';

import { deviceMessagingConfigSchema } from '#src/config/schema.js';
import { createBaseService } from '#src/engine/base.js';
import { createIncomingService } from '#src/engine/incoming.js';
import { createOutgoingService } from '#src/engine/outgoing.js';
import type { DeviceMessage, ParsedIncomingEvent } from '#src/lib/device-message/types.js';
import { sleep } from '#src/lib/utilities.js';
import type { DeviceMessagingPlugin } from '#src/plugins/plugin.interface.js';
import type { PluginRegistry } from '#src/plugins/registry.js';
import { createStubPullPlugin, STUB_PULL_ID } from '#src/plugins/stub/index.js';
import { noopMetrics } from '../helpers/noop-metrics.js';
import { waitForPostSend } from '../helpers/wait-for-post-send.js';

const shouldRun = process.env.RUN_REDIS_SMOKE === '1';

const delivery = deviceMessagingConfigSchema.parse({
  $schemaVersion: '1',
}).delivery;

/**
 * Catalog stub-pull always returns null from fetchStatus; wrap so one poll
 * completes the message (same shared `_processIncomingEvent` as ingress).
 * Short `initialPollDelayMs` so the smoke need not wait 10s.
 */
function createPullRegistryWithSuccessFetch(): PluginRegistry {
  const base = createStubPullPlugin({ id: STUB_PULL_ID });
  const plugin: DeviceMessagingPlugin = {
    ...base,
    tuning: { ...base.tuning, initialPollDelayMs: 1 },
    incoming: {
      fetchStatus: async (message: DeviceMessage): Promise<ParsedIncomingEvent | null> => ({
        deliveryQueueId: message.deliveryQueueId,
        deliveryStatus: 'DELIVERY_SUCCESSFUL',
        device: message.device,
        response: { status: 'EXECUTION_SUCCESS' },
      }),
    },
  };

  return {
    get: id => (id === plugin.id ? plugin : undefined),
    getAll: () => [ plugin ],
    getByDeliveryPattern: pattern => (pattern === 'PULL' ? [ plugin ] : []),
  };
}

describe.skipIf(!shouldRun)('incoming pollPullPlugins', () => {
  let redisRepo: typeof import('../../src/lib/redis-repository/index.js').redisRepo;
  let redisKeys: typeof import('../../src/lib/redis-repository/keys.js').redisKeys;

  afterAll(async () => {
    if (redisRepo) {
      await redisRepo.client.quit();
    }
  });

  it('stub-pull: awaiting-task → poll success → message cleaned up', async () => {
    ({ redisRepo } = await import('../../src/lib/redis-repository/index.js'));
    ({ redisKeys } = await import('../../src/lib/redis-repository/keys.js'));

    const registry = createPullRegistryWithSuccessFetch();
    const metrics = noopMetrics;
    const baseService = createBaseService({ registry, delivery, metrics });
    const outgoingService = createOutgoingService({
      registry,
      delivery,
      baseService,
      metrics,
      kickDistributeOnEnqueue: false,
    });
    const incomingService = createIncomingService({
      registry,
      delivery,
      baseService,
      metrics,
    });

    const correlationId = `poll-pull-${ Date.now() }`;
    const relayNodeId = 8;
    const queueKey = `queue:stub-pull:relayNode:${ relayNodeId }`;
    const rateLimitKey = `rate_limit:stub-pull:relayNode:${ relayNodeId }`;
    const awaitingKey = redisKeys.queueAwaitingTask(STUB_PULL_ID);

    let enqueuedId: string | undefined;
    try {
      const enqueued = await outgoingService.enqueue({
        commandType: 'READ_CREDIT',
        priority: 1,
        pluginId: STUB_PULL_ID,
        networkId: null,
        correlationId,
        device: {
          type: 'ELECTRICITY_METER',
          externalReference: 'poll-pull-meter',
          relayNode: { id: relayNodeId },
        },
      });
      enqueuedId = enqueued.id;

      await outgoingService.distributeToNetworkServers();
      const afterSend = await waitForPostSend(outgoingService, correlationId);
      expect(afterSend.deliveryQueueId).toMatch(/^stub-ext-/);
      expect(await redisRepo.client.zscore(awaitingKey, enqueued.id)).not.toBeNull();

      // firstPollAt = now + initialPollDelayMs (1ms); wait until due.
      await sleep(5);
      await incomingService.pollPullPlugins();

      const afterPoll = await outgoingService.getByCorrelationId(correlationId);
      expect(afterPoll).toBeNull();
      expect(await redisRepo.client.zscore(awaitingKey, enqueued.id)).toBeNull();
      // Success cleanup must release the slot (key was stored on the message at claim).
      expect(await redisRepo.client.sismember(rateLimitKey, enqueued.id)).toBe(0);
    }
    finally {
      const leftover = await outgoingService.getByCorrelationId(correlationId);
      if (leftover) {
        await redisRepo.client.zrem(queueKey, leftover.id);
        await redisRepo.messageFullCleanup(leftover);
      }
      else if (enqueuedId) {
        await redisRepo.client.srem(rateLimitKey, enqueuedId);
      }
      await redisRepo.client.srem(
        redisKeys.listOfInitialQueuesToDistributeFrom(),
        queueKey,
      );
    }
  });
});
