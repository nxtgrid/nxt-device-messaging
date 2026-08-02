/**
 * Real {@link createOutgoing} smoke: enqueue → distribute tick → SENT_TO_NS (Unit 5.3).
 * Stops before sendOne (Unit 5.4).
 *
 * Opt-in (needs Valkey):
 *
 *   docker compose up -d valkey
 *   RUN_REDIS_SMOKE=1 pnpm exec vitest run test/integration/outgoing-distribute.smoke.spec.ts
 */
import { afterAll, describe, expect, it } from 'vitest';

import { deviceMessagingConfigSchema } from '../../src/config/schema.js';
import { createBase } from '../../src/engine/base.js';
import { createOutgoing } from '../../src/engine/outgoing.js';
import { QUEUE_NS_KEY } from '../../src/lib/queue-moving.js';
import {
  STUB_PULL_ID,
  STUB_PUSH_ID,
} from '../../src/plugins/stub/index.js';
import { createPluginRegistry } from '../../src/plugins/registry.js';

const shouldRun = process.env.RUN_REDIS_SMOKE === '1';
const delivery = deviceMessagingConfigSchema.parse({ $schemaVersion: '1' }).delivery;

describe.skipIf(!shouldRun)('outgoing enqueue → distributeToNetworkServers', () => {
  let redisRepo: typeof import('../../src/lib/redis-repository/index.js').redisRepo;
  let redisKeys: typeof import('../../src/lib/redis-repository/keys.js').redisKeys;

  afterAll(async () => {
    if (redisRepo) {
      await redisRepo.client.quit();
    }
  });

  it('stub-push: spacing admit + pick moves message to NS queue', async () => {
    ({ redisRepo } = await import('../../src/lib/redis-repository/index.js'));
    ({ redisKeys } = await import('../../src/lib/redis-repository/keys.js'));

    const registry = createPluginRegistry([ { id: STUB_PUSH_ID } ]);
    const outgoing = createOutgoing({
      registry,
      delivery,
      base: createBase({ registry, delivery }),
      kickDistributeOnEnqueue: false,
    });

    const correlationId = `distribute-push-${ Date.now() }`;
    const networkId = 91;
    const queueKey = `queue:stub-push:network:${ networkId }`;

    const enqueued = await outgoing.enqueue({
      commandType: 'READ',
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

    await outgoing.distributeToNetworkServers();

    const after = await outgoing.getByCorrelationId(correlationId);
    expect(after?.deliveryStatus).toBe('SENT_TO_NS');
    expect(await redisRepo.client.zscore(queueKey, enqueued.id)).toBeNull();
    expect(await redisRepo.client.zscore(QUEUE_NS_KEY, enqueued.id)).not.toBeNull();

    // Spacing lock held — second tick must not pick (queue empty anyway after pick).
    await outgoing.distributeToNetworkServers();

    await redisRepo.messageFullCleanup(after!);
    await redisRepo.client.srem(
      redisKeys.listOfInitialQueuesToDistributeFrom(),
      queueKey,
    );
    await redisRepo.client.del(redisKeys.lockForQueue(queueKey));
  });

  it('stub-pull: concurrency admit + claim writes derived rate-limit membership', async () => {
    ({ redisRepo } = await import('../../src/lib/redis-repository/index.js'));
    ({ redisKeys } = await import('../../src/lib/redis-repository/keys.js'));

    const registry = createPluginRegistry([ { id: STUB_PULL_ID } ]);
    const outgoing = createOutgoing({
      registry,
      delivery,
      base: createBase({ registry, delivery }),
      kickDistributeOnEnqueue: false,
    });

    const correlationId = `distribute-pull-${ Date.now() }`;
    const gatewayId = 7;
    const queueKey = `queue:stub-pull:gateway:${ gatewayId }`;
    const rateLimitKey = `rate_limit:stub-pull:gateway:${ gatewayId }`;

    const enqueued = await outgoing.enqueue({
      commandType: 'READ',
      priority: 1,
      pluginId: STUB_PULL_ID,
      networkId: null,
      correlationId,
      device: {
        type: 'ELECTRICITY_METER',
        externalReference: 'distribute-pull-meter',
        gateway: { id: gatewayId },
      },
    });

    await outgoing.distributeToNetworkServers();

    const after = await outgoing.getByCorrelationId(correlationId);
    expect(after?.deliveryStatus).toBe('SENT_TO_NS');
    expect(await redisRepo.client.sismember(rateLimitKey, enqueued.id)).toBe(1);
    expect(await redisRepo.client.zscore(QUEUE_NS_KEY, enqueued.id)).not.toBeNull();

    await redisRepo.messageFullCleanup(after!, { concurrencyRateLimitKey: rateLimitKey });
    await redisRepo.client.srem(
      redisKeys.listOfInitialQueuesToDistributeFrom(),
      queueKey,
    );
  });
});
