/**
 * Real runMessageResolutionCycle smoke (Unit 5.6 Step B):
 * enqueue → park in retry with past score → resolution tick → back to initial queue.
 *
 * Opt-in (needs Valkey):
 *
 *   docker compose up -d valkey
 *   RUN_REDIS_SMOKE=1 pnpm exec vitest run test/integration/outgoing-resolution.smoke.spec.ts
 */
import { afterAll, describe, expect, it } from 'vitest';

import { deviceMessagingConfigSchema } from '../../src/config/schema.js';
import { createBaseService } from '../../src/engine/base.js';
import { createOutgoingService } from '../../src/engine/outgoing.js';
import { QUEUE_RETRY_KEY } from '../../src/lib/queue-moving.js';
import { sleep } from '../../src/lib/utilities.js';
import { createPluginRegistry } from '../../src/plugins/registry.js';
import { STUB_PUSH_ID } from '../../src/plugins/stub/index.js';

const shouldRun = process.env.RUN_REDIS_SMOKE === '1';
const delivery = deviceMessagingConfigSchema.parse({ $schemaVersion: '1' }).delivery;

describe.skipIf(!shouldRun)('outgoing runMessageResolutionCycle', () => {
  let redisRepo: typeof import('../../src/lib/redis-repository/index.js').redisRepo;
  let redisKeys: typeof import('../../src/lib/redis-repository/keys.js').redisKeys;

  afterAll(async () => {
    if (redisRepo) {
      await redisRepo.client.quit();
    }
  });

  it('requeues a due TO_RETRY message and kicks distribute', async () => {
    ({ redisRepo } = await import('../../src/lib/redis-repository/index.js'));
    ({ redisKeys } = await import('../../src/lib/redis-repository/keys.js'));

    const registry = createPluginRegistry([ { id: STUB_PUSH_ID } ]);
    const outgoingService = createOutgoingService({
      registry,
      delivery,
      baseService: createBaseService({ registry, delivery }),
      kickDistributeOnEnqueue: false,
    });

    const correlationId = `resolution-smoke-${ Date.now() }`;
    const networkId = 77;
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
          externalReference: 'resolution-smoke-meter',
        },
      });

      // Park in retry with an already-due score (resolution step 4).
      await redisRepo.client.zrem(queueKey, enqueued.id);
      await redisRepo.client.hset(redisKeys.message(enqueued.id), {
        deliveryStatus: 'TO_RETRY',
      });
      await redisRepo.client.zadd(QUEUE_RETRY_KEY, Date.now() - 1, enqueued.id);

      await outgoingService.runMessageResolutionCycle();

      expect(await redisRepo.client.zscore(QUEUE_RETRY_KEY, enqueued.id)).toBeNull();

      // Requeue restores QUEUED; fire-and-forget distribute may already have picked it.
      await sleep(50);
      const after = await outgoingService.getByCorrelationId(correlationId);
      expect(after).not.toBeNull();
      expect([ 'QUEUED', 'SENT_TO_NS', 'DELIVERED_TO_NS' ]).toContain(after?.deliveryStatus);
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
    }
  });
});

