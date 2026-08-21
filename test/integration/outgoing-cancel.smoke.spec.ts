/**
 * Real {@link createOutgoingService} smoke: enqueue → cancel → get (Unit 5.2).
 *
 * Opt-in (needs Valkey), same gate as `redis.smoke.spec.ts`:
 *
 *   docker compose up -d valkey
 *   RUN_REDIS_SMOKE=1 pnpm exec vitest run test/integration/outgoing-cancel.smoke.spec.ts
 *
 * Future (not this file): thorough `messageFullCleanup` coverage. A single enqueue into
 * an empty DB creates four Redis entries — `device_message:{id}`, correlation index,
 * bottleneck queue membership, and `queues_to_distribute_from`. Messages then move
 * through stage queues; at every exit path the message and all references must be gone.
 * Tracked in `docs/decisions-log.md` (carried findings).
 */
import { afterAll, describe, expect, it } from 'vitest';

import { createBaseService } from '#src/engine/base.js';
import { createOutgoingService } from '#src/engine/outgoing.js';
import { sleep } from '#src/lib/utilities.js';
import { createPluginRegistry } from '#src/plugins/registry.js';
import { STUB_PUSH_ID } from '#src/plugins/stub/index.js';
import { noopMetrics } from '../helpers/noop-metrics.js';

const shouldRun = process.env.RUN_REDIS_SMOKE === '1';
const goSlow = false;

describe.skipIf(!shouldRun)('outgoing enqueue → cancel → get', () => {
  let redisRepo: typeof import('../../src/lib/redis-repository/index.js').redisRepo;
  let redisKeys: typeof import('../../src/lib/redis-repository/keys.js').redisKeys;

  afterAll(async () => {
    if (redisRepo) {
      await redisRepo.client.quit();
    }
  });

  it('cancels a QUEUED message via real outgoing + Redis', async () => {
    ({ redisRepo } = await import('../../src/lib/redis-repository/index.js'));
    ({ redisKeys } = await import('../../src/lib/redis-repository/keys.js'));

    const registry = createPluginRegistry([ { id: STUB_PUSH_ID } ]);
    const { deviceMessagingConfigSchema } = await import('../../src/config/schema.js');
    const delivery = deviceMessagingConfigSchema.parse({ $schemaVersion: '1' }).delivery;
    const metrics = noopMetrics;
    // Keep QUEUED for cancel — kick would race distribute into SENT_TO_NS.
    const outgoingService = createOutgoingService({
      registry,
      delivery,
      baseService: createBaseService({ delivery, metrics }),
      metrics,
      kickDistributeOnEnqueue: false,
    });

    const correlationId = `cancel-smoke-${ Date.now() }`;
    const networkId = 42;
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
          externalReference: 'cancel-smoke-meter',
        },
      });

      expect(enqueued.deliveryStatus).toBe('QUEUED');
      expect(await outgoingService.getByCorrelationId(correlationId)).not.toBeNull();
      expect(await redisRepo.client.zscore(queueKey, enqueued.id)).not.toBeNull();

      if (goSlow) await sleep(4000);

      const cancel = await outgoingService.cancelOne(correlationId);
      expect(cancel).toEqual({ correlationId, result: 'CANCELLED' });

      expect(await outgoingService.getByCorrelationId(correlationId)).toBeNull();
      expect(await redisRepo.client.zscore(queueKey, enqueued.id)).toBeNull();
      expect(await redisRepo.client.exists(redisKeys.message(enqueued.id))).toBe(0);
    }
    finally {
      // messageFullCleanup does not SREM queues_to_distribute_from (distributor Lua does).
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
