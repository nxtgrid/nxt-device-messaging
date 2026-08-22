/**
 * Real lifecycle-runner PULL poll smoke (Unit 5.5 Step B):
 * enqueue → distribute → sendOne → awaiting-task → tick → cleanup.
 *
 * Opt-in (needs Valkey):
 *
 *   docker compose up -d valkey
 *   RUN_REDIS_SMOKE=1 pnpm exec vitest run test/integration/incoming-poll.smoke.spec.ts
 */
import { afterAll, describe, expect, it } from 'vitest';

import { deviceMessagingConfigSchema } from '#src/config/schema.js';
import type { DeviceMessage, ParsedIncomingEvent } from '#src/lib/device-message/types.js';
import { sleep } from '#src/lib/utilities.js';
import type { PullPlugin } from '#src/plugins/plugin.interface.js';
import type { PluginRegistry } from '#src/plugins/registry.js';
import { createStubPullPlugin, STUB_PULL_ID } from '#src/plugins/stub/index.js';
import { createEngineHarness } from '../helpers/engine-harness.js';
import { createSinglePluginRegistry } from '../helpers/programmable-plugin.js';
import { purgeMessageReferences } from '../helpers/redis-references.js';
import { waitForPostSend } from '../helpers/wait-for-post-send.js';

const shouldRun = process.env.RUN_REDIS_SMOKE === '1';

const delivery = deviceMessagingConfigSchema.parse({
  $schemaVersion: '1',
}).delivery;

/**
 * Catalog stub-pull always returns null from fetchStatus; wrap so one poll
 * completes the message (same shared `processEvent` as ingress).
 * Short `initialPollDelayMs` so the smoke need not wait 10s.
 */
function createPullRegistryWithSuccessFetch(): PluginRegistry {
  const base = createStubPullPlugin({ id: STUB_PULL_ID });
  const plugin: PullPlugin = {
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

  return createSinglePluginRegistry(plugin);
}

describe.skipIf(!shouldRun)('incoming awaiting-task poll via runner.tick', () => {
  let redis: typeof import('../../src/lib/redis-repository/client.js').redis;
  let redisKeys: typeof import('../../src/lib/redis-repository/keys.js').redisKeys;

  afterAll(async () => {
    if (redis) {
      await redis.quit();
    }
  });

  it('stub-pull: awaiting-task → poll success → message cleaned up', async () => {
    ({ redis } = await import('../../src/lib/redis-repository/client.js'));
    ({ redisKeys } = await import('../../src/lib/redis-repository/keys.js'));

    const registry = createPullRegistryWithSuccessFetch();
    const { outgoing: outgoingService, runner } = createEngineHarness({
      registry,
      delivery,
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
      expect(await redis.zscore(awaitingKey, enqueued.id)).not.toBeNull();

      // firstPollAt = now + initialPollDelayMs (1ms); wait until due.
      await sleep(5);
      await runner.tick();

      const afterPoll = await outgoingService.getByCorrelationId(correlationId);
      expect(afterPoll).toBeNull();
      expect(await redis.zscore(awaitingKey, enqueued.id)).toBeNull();
      // Success cleanup must release the slot (key was stored on the message at claim).
      expect(await redis.sismember(rateLimitKey, enqueued.id)).toBe(0);
    }
    finally {
      const leftover = await outgoingService.getByCorrelationId(correlationId);
      if (leftover) {
        await redis.zrem(queueKey, leftover.id);
        await purgeMessageReferences(leftover.id, { correlationId });
      }
      else if (enqueuedId) {
        await redis.srem(rateLimitKey, enqueuedId);
      }
      await redis.srem(
        redisKeys.listOfInitialQueuesToDistributeFrom(),
        queueKey,
      );
    }
  });
});
