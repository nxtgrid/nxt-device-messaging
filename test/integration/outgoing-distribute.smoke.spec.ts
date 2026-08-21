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
import { createInFlightSends } from '#src/engine/in-flight-sends.js';
import { QUEUE_NS_KEY, STAGES } from '#src/engine/lifecycle/stages.js';
import { createOutgoingService } from '#src/engine/outgoing.js';
import { createAdmissionStore } from '#src/lib/redis-repository/admission-store.js';
import { createMessageStore } from '#src/lib/redis-repository/message-store.js';
import { createStageStore } from '#src/lib/redis-repository/stage-store.js';
import { createPluginRegistry } from '#src/plugins/registry.js';
import {
  STUB_PULL_ID,
  STUB_PUSH_ID,
} from '#src/plugins/stub/index.js';
import { noopMetrics } from '../helpers/noop-metrics.js';
import { purgeMessageReferences } from '../helpers/redis-references.js';
import {
  POST_SEND_STATUS,
  waitForPostSend,
} from '../helpers/wait-for-post-send.js';

const shouldRun = process.env.RUN_REDIS_SMOKE === '1';
const delivery = deviceMessagingConfigSchema.parse({ $schemaVersion: '1' }).delivery;

describe.skipIf(!shouldRun)('outgoing enqueue → distribute → sendOne', () => {
  let redis: typeof import('../../src/lib/redis-repository/client.js').redis;
  let redisKeys: typeof import('../../src/lib/redis-repository/keys.js').redisKeys;

  afterAll(async () => {
    if (redis) {
      await redis.quit();
    }
  });

  it('stub-push: spacing admit → NS → GW (PUSH post-send)', async () => {
    ({ redis } = await import('../../src/lib/redis-repository/client.js'));
    ({ redisKeys } = await import('../../src/lib/redis-repository/keys.js'));

    const registry = createPluginRegistry([ { id: STUB_PUSH_ID } ]);
    const metrics = noopMetrics;
    const inFlightSends = createInFlightSends();
    const messageStore = createMessageStore({ client: redis });
    const stageStore = createStageStore({ client: redis });
    const outgoingService = createOutgoingService({
      registry,
      delivery,
      baseService: createBaseService({ delivery, metrics, messageStore, stageStore }),
      inFlightSends,
      metrics,
      engineEnabled: false,
      admissionStore: createAdmissionStore({ client: redis }),
      messageStore,
      stageStore,
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
      expect(await redis.zscore(queueKey, enqueued.id)).toBeNull();
      expect(await redis.zscore(QUEUE_NS_KEY, enqueued.id)).toBeNull();
      expect(await redis.zscore(STAGES.relayNode.key(), enqueued.id)).not.toBeNull();
    }
    finally {
      const leftover = await outgoingService.getByCorrelationId(correlationId);
      if (leftover) {
        await purgeMessageReferences(leftover.id, { correlationId });
      }
      await redis.srem(
        redisKeys.listOfInitialQueuesToDistributeFrom(),
        queueKey,
      );
      await redis.del(redisKeys.lockForQueue(queueKey));
    }
  });

  it('stub-pull: concurrency claim → NS → awaiting-task (PULL post-send)', async () => {
    ({ redis } = await import('../../src/lib/redis-repository/client.js'));
    ({ redisKeys } = await import('../../src/lib/redis-repository/keys.js'));

    const registry = createPluginRegistry([ { id: STUB_PULL_ID } ]);
    const metrics = noopMetrics;
    const inFlightSends = createInFlightSends();
    const messageStore = createMessageStore({ client: redis });
    const stageStore = createStageStore({ client: redis });
    const outgoingService = createOutgoingService({
      registry,
      delivery,
      baseService: createBaseService({ delivery, metrics, messageStore, stageStore }),
      inFlightSends,
      metrics,
      engineEnabled: false,
      admissionStore: createAdmissionStore({ client: redis }),
      messageStore,
      stageStore,
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
      expect(await redis.sismember(rateLimitKey, enqueued.id)).toBe(1);
      expect(await redis.zscore(QUEUE_NS_KEY, enqueued.id)).toBeNull();
      expect(await redis.zscore(awaitingKey, enqueued.id)).not.toBeNull();
    }
    finally {
      const leftover = await outgoingService.getByCorrelationId(correlationId);
      if (leftover) {
        await redis.zrem(queueKey, leftover.id);
        await purgeMessageReferences(leftover.id, { correlationId });
      }
      await redis.srem(
        redisKeys.listOfInitialQueuesToDistributeFrom(),
        queueKey,
      );
    }
  });
});
