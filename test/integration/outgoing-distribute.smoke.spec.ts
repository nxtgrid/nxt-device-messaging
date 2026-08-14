/**
 * Real {@link createOutgoingService} smoke: enqueue → distribute tick → sendOne → post-send
 * queue (Unit 5.4). Fire-and-forget send — poll for DELIVERED_TO_NS.
 *
 * Opt-in (needs Valkey):
 *
 *   docker compose up -d valkey
 *   RUN_REDIS_SMOKE=1 pnpm exec vitest run test/integration/outgoing-distribute.smoke.spec.ts
 */
import { afterAll, describe, expect, it } from 'vitest';

import { deviceMessagingConfigSchema } from '#src/config/schema.js';
import { createBaseService } from '#src/engine/base.js';
import { createOutgoingService } from '#src/engine/outgoing.js';
import { QUEUE_NS_KEY } from '#src/lib/queue-moving.js';
import { QUEUE_RELAY_NODE_KEY } from '#src/lib/queue-moving.push.js';
import { createPluginRegistry } from '#src/plugins/registry.js';
import {
  STUB_PULL_ID,
  STUB_PUSH_ID,
} from '#src/plugins/stub/index.js';
import { noopMetrics } from '../helpers/noop-metrics.js';
import {
  POST_SEND_STATUS,
  waitForPostSend,
} from '../helpers/wait-for-post-send.js';

const shouldRun = process.env.RUN_REDIS_SMOKE === '1';
const delivery = deviceMessagingConfigSchema.parse({ $schemaVersion: '1' }).delivery;

describe.skipIf(!shouldRun)('outgoing enqueue → distribute → sendOne', () => {
  let redisRepo: typeof import('../../src/lib/redis-repository/index.js').redisRepo;
  let redisKeys: typeof import('../../src/lib/redis-repository/keys.js').redisKeys;

  afterAll(async () => {
    if (redisRepo) {
      await redisRepo.client.quit();
    }
  });

  it('stub-push: spacing admit → NS → GW (PUSH post-send)', async () => {
    ({ redisRepo } = await import('../../src/lib/redis-repository/index.js'));
    ({ redisKeys } = await import('../../src/lib/redis-repository/keys.js'));

    const registry = createPluginRegistry([ { id: STUB_PUSH_ID } ]);
    const metrics = noopMetrics;
    const outgoingService = createOutgoingService({
      registry,
      delivery,
      baseService: createBaseService({ registry, delivery, metrics }),
      metrics,
      kickDistributeOnEnqueue: false,
    });

    const correlationId = `distribute-push-${ Date.now() }`;
    const networkId = 91;
    const queueKey = `queue:stub-push:network:${ networkId }`;

    try {
      const enqueued = await outgoingService.enqueue({
        commandType: 'READ_CREDIT',
        priority: 1,
        pluginId: STUB_PUSH_ID,
        networkId,
        correlationId,
        device: {
          type: 'ELECTRICITY_METER',
          externalReference: 'distribute-push-meter',
        },
      });

      expect(enqueued.deliveryStatus).toBe('QUEUED');

      await outgoingService.distributeToNetworkServers();
      const after = await waitForPostSend(outgoingService, correlationId);

      expect(after.deliveryStatus).toBe(POST_SEND_STATUS);
      expect(after.deliveryQueueId).toMatch(/^stub-ext-/);
      expect(await redisRepo.client.zscore(queueKey, enqueued.id)).toBeNull();
      expect(await redisRepo.client.zscore(QUEUE_NS_KEY, enqueued.id)).toBeNull();
      expect(await redisRepo.client.zscore(QUEUE_RELAY_NODE_KEY, enqueued.id)).not.toBeNull();
    }
    finally {
      const leftover = await outgoingService.getByCorrelationId(correlationId);
      if (leftover) {
        await redisRepo.messageFullCleanup(leftover);
      }
      await redisRepo.client.srem(
        redisKeys.listOfInitialQueuesToDistributeFrom(),
        queueKey,
      );
      await redisRepo.client.del(redisKeys.lockForQueue(queueKey));
    }
  });

  it('stub-pull: concurrency claim → NS → awaiting-task (PULL post-send)', async () => {
    ({ redisRepo } = await import('../../src/lib/redis-repository/index.js'));
    ({ redisKeys } = await import('../../src/lib/redis-repository/keys.js'));

    const registry = createPluginRegistry([ { id: STUB_PULL_ID } ]);
    const metrics = noopMetrics;
    const outgoingService = createOutgoingService({
      registry,
      delivery,
      baseService: createBaseService({ registry, delivery, metrics }),
      metrics,
      kickDistributeOnEnqueue: false,
    });

    const correlationId = `distribute-pull-${ Date.now() }`;
    const relayNodeId = 7;
    const queueKey = `queue:stub-pull:relayNode:${ relayNodeId }`;
    const rateLimitKey = `rate_limit:stub-pull:relayNode:${ relayNodeId }`;
    const awaitingKey = redisKeys.queueAwaitingTask(STUB_PULL_ID);

    try {
      const enqueued = await outgoingService.enqueue({
        commandType: 'READ_CREDIT',
        priority: 1,
        pluginId: STUB_PULL_ID,
        networkId: null,
        correlationId,
        device: {
          type: 'ELECTRICITY_METER',
          externalReference: 'distribute-pull-meter',
          relayNode: { id: relayNodeId },
        },
      });

      await outgoingService.distributeToNetworkServers();
      const after = await waitForPostSend(outgoingService, correlationId);

      expect(after.deliveryStatus).toBe(POST_SEND_STATUS);
      expect(after.deliveryQueueId).toMatch(/^stub-ext-/);
      expect(await redisRepo.client.sismember(rateLimitKey, enqueued.id)).toBe(1);
      expect(await redisRepo.client.zscore(QUEUE_NS_KEY, enqueued.id)).toBeNull();
      expect(await redisRepo.client.zscore(awaitingKey, enqueued.id)).not.toBeNull();
    }
    finally {
      const leftover = await outgoingService.getByCorrelationId(correlationId);
      if (leftover) {
        await redisRepo.client.zrem(queueKey, leftover.id);
        await redisRepo.messageFullCleanup(leftover);
      }
      await redisRepo.client.srem(
        redisKeys.listOfInitialQueuesToDistributeFrom(),
        queueKey,
      );
    }
  });
});
