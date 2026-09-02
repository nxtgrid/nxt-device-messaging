/**
 * Real {@link createOutgoingService} smoke: enqueue → cancel → get (Unit 5.2).
 *
 * Opt-in (needs Valkey), same gate as `redis.smoke.spec.ts`:
 *
 *   docker compose up -d valkey
 *   pnpm exec vitest run test/integration/outgoing-cancel.smoke.spec.ts
 *
 * Future (not this file): thorough `messageFullCleanup` coverage. A single enqueue into
 * an empty DB creates four Redis entries — `device_message:{id}`, correlation index,
 * bottleneck queue membership, and `queues_to_distribute_from`. Messages then move
 * through stage queues; at every exit path the message and all references must be gone.
 * Tracked in `docs/decisions-log.md` (carried findings).
 */
import { afterAll, describe, expect, it } from 'vitest';

import { createBaseService } from '#src/engine/base.js';
import { createInFlightSends } from '#src/engine/in-flight-sends.js';
import { createStageMoves } from '#src/engine/lifecycle/moves.js';
import { createOutgoingService } from '#src/engine/outgoing.js';
import { createAdmissionStore } from '#src/lib/redis-repository/admission-store.js';
import { createMessageStore } from '#src/lib/redis-repository/message-store.js';
import { createStageStore } from '#src/lib/redis-repository/stage-store.js';
import { sleep } from '#src/lib/utilities.js';
import { createPluginRegistry } from '#src/plugins/registry.js';
import { STUB_PUSH_ID } from '#src/plugins/stub/index.js';
import { noopMetrics } from '../helpers/noop-metrics.js';
import { purgeMessageReferences } from '../helpers/redis-references.js';

const goSlow = false;

describe('outgoing enqueue → cancel → get', () => {
  let redis: typeof import('../../src/lib/redis-repository/client.js').redis;
  let redisKeys: typeof import('../../src/lib/redis-repository/keys.js').redisKeys;

  afterAll(async () => {
    if (redis) {
      await redis.quit();
    }
  });

  it('cancels a QUEUED message via real outgoing + Redis', async () => {
    ({ redis } = await import('../../src/lib/redis-repository/client.js'));
    ({ redisKeys } = await import('../../src/lib/redis-repository/keys.js'));

    const registry = createPluginRegistry([ { id: STUB_PUSH_ID } ]);
    const { deviceMessagingConfigSchema } = await import('../../src/config/schema.js');
    const delivery = deviceMessagingConfigSchema.parse({ $schemaVersion: '1' }).delivery;
    const metrics = noopMetrics;
    const inFlightSends = createInFlightSends();
    const messageStore = createMessageStore({ client: redis });
    const stageStore = createStageStore({ client: redis });
    const moves = createStageMoves({ delivery, metrics, stageStore });
    // Keep QUEUED for cancel — kick would race distribute into SENT_TO_NS.
    const outgoingService = createOutgoingService({
      registry,
      delivery,
      baseService: createBaseService({ delivery, metrics, messageStore, moves }),
      inFlightSends,
      metrics,
      engineEnabled: false,
      admissionStore: createAdmissionStore({ client: redis }),
      messageStore,
      moves,
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
      expect(await redis.zscore(queueKey, enqueued.id)).not.toBeNull();

      if (goSlow) await sleep(4000);

      const cancel = await outgoingService.cancelOne(correlationId);
      expect(cancel).toEqual({ correlationId, result: 'CANCELLED' });

      expect(await outgoingService.getByCorrelationId(correlationId)).toBeNull();
      expect(await redis.zscore(queueKey, enqueued.id)).toBeNull();
      expect(await redis.exists(redisKeys.message(enqueued.id))).toBe(0);
    }
    finally {
      // purgeMessageReferences does not SREM queues_to_distribute_from (distributor Lua does).
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
