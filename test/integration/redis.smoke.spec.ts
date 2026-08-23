/**
 * Redis repository smoke test (Unit 2 / I3 camelCase).
 *
 * Opt-in so default `pnpm test` / CI does not require Valkey:
 *
 *   docker compose up -d valkey
 *   RUN_REDIS_SMOKE=1 pnpm exec vitest run test/integration/redis.smoke.spec.ts
 *
 * Exercises: module load (REDIS_* options + Lua defineCommand), PING, enqueue → get → cleanup.
 */
import { afterAll, describe, expect, it } from 'vitest';

const shouldRun = process.env.RUN_REDIS_SMOKE === '1';

describe.skipIf(!shouldRun)('redis repository smoke', () => {
  let redis: typeof import('../../src/lib/redis-repository/client.js').redis;
  let redisKeys: typeof import('../../src/lib/redis-repository/keys.js').redisKeys;

  afterAll(async () => {
    if (redis) {
      await redis.quit();
    }
  });

  it('connects, registers Lua commands, and round-trips a message', async () => {
    ({ redis } = await import('../../src/lib/redis-repository/client.js'));
    ({ redisKeys } = await import('../../src/lib/redis-repository/keys.js'));
    const { createMessageStore } = await import('../../src/lib/redis-repository/message-store.js');
    const { createStageStore } = await import('../../src/lib/redis-repository/stage-store.js');
    const messageStore = createMessageStore({ client: redis });
    const stageStore = createStageStore({ client: redis });

    expect(await redis.ping()).toBe('PONG');
    expect(typeof redis.fetchNextMessageInQueueAndMove).toBe('function');
    expect(typeof redis.moveMessageBetweenQueues).toBe('function');

    const correlationId = `smoke-${ Date.now() }`;
    const queueKey = `queue:smoke:${ correlationId }`;

    try {
      const enqueued = await messageStore.enqueueDeviceMessage(
        {
          commandType: 'READ_CREDIT',
          priority: 1,
          pluginId: 'smoke-test',
          networkId: null,
          correlationId,
          device: {
            type: 'ELECTRICITY_METER',
            externalReference: 'smoke-meter',
          },
        },
        queueKey,
        604800,
      );

      expect(enqueued.commandType).toBe('READ_CREDIT');
      expect(enqueued.deliveryStatus).toBe('QUEUED');

      const message = await messageStore.getMessageFromCorrelationId(correlationId);
      expect(message).not.toBeNull();
      expect(message?.commandType).toBe('READ_CREDIT');
      expect(message?.pluginId).toBe('smoke-test');
      expect(message?.networkId).toBeNull();
      expect(message?.deliveryStatus).toBe('QUEUED');
      expect(message?.device.externalReference).toBe('smoke-meter');

      // The caller names the queues to sweep; here that is just the initial queue this
      // message was enqueued into (`StageMoves.purge` derives the real list).
      await stageStore.messageFullCleanup(message!, [ queueKey ]);

      // messageFullCleanup does not SREM queues_to_distribute_from — the distributor Lua
      // GC's that when a queue empties. Smoke has no distribute pass, so tidy explicitly.
      await redis.srem(
        redisKeys.listOfInitialQueuesToDistributeFrom(),
        queueKey,
      );

      expect(await messageStore.getMessageFromCorrelationId(correlationId)).toBeNull();
      expect(await redis.zcard(queueKey)).toBe(0);
      expect(await redis.sismember(
        redisKeys.listOfInitialQueuesToDistributeFrom(),
        queueKey,
      )).toBe(0);
    }
    finally {
      const leftover = await messageStore.getMessageFromCorrelationId(correlationId);
      if (leftover) {
        await stageStore.messageFullCleanup(leftover, [ queueKey ]);
      }
      await redis.srem(
        redisKeys.listOfInitialQueuesToDistributeFrom(),
        queueKey,
      );
      await redis.del(queueKey);
    }
  });

  it('fetch-next Lua refuses to pop when the concurrency cap is full', async () => {
    ({ redis } = await import('../../src/lib/redis-repository/client.js'));
    ({ redisKeys } = await import('../../src/lib/redis-repository/keys.js'));
    const { createMessageStore } = await import('../../src/lib/redis-repository/message-store.js');
    const { createStageStore } = await import('../../src/lib/redis-repository/stage-store.js');
    const messageStore = createMessageStore({ client: redis });
    const stageStore = createStageStore({ client: redis });

    const stamp = Date.now();
    const sourceQueue = `queue:cap:${ stamp }`;
    const destQueue = `queue:cap-ns:${ stamp }`;
    const concurrencySet = `rate_limit:cap:${ stamp }`;
    const correlationA = `cap-a-${ stamp }`;
    const correlationB = `cap-b-${ stamp }`;

    try {
      const first = await messageStore.enqueueDeviceMessage(
        {
          commandType: 'READ_CREDIT',
          priority: 2,
          pluginId: 'smoke-test',
          networkId: null,
          correlationId: correlationA,
          device: { type: 'ELECTRICITY_METER', externalReference: 'cap-meter-a' },
        },
        sourceQueue,
        604800,
      );
      const second = await messageStore.enqueueDeviceMessage(
        {
          commandType: 'READ_CREDIT',
          priority: 1,
          pluginId: 'smoke-test',
          networkId: null,
          correlationId: correlationB,
          device: { type: 'ELECTRICITY_METER', externalReference: 'cap-meter-b' },
        },
        sourceQueue,
        604800,
      );

      const picked = await stageStore.fetchNextMessageInQueueAndMove(
        sourceQueue,
        destQueue,
        redisKeys.listOfInitialQueuesToDistributeFrom(),
        concurrencySet,
        Date.now() + 5_000,
        'SENT_TO_NS',
        1,
      );

      expect(picked?.[0]).toBe(first.id);
      expect(await redis.scard(concurrencySet)).toBe(1);
      expect(await redis.hget(redisKeys.message(first.id), 'concurrencyRateLimitKey'))
        .toBe(concurrencySet);

      const refused = await stageStore.fetchNextMessageInQueueAndMove(
        sourceQueue,
        destQueue,
        redisKeys.listOfInitialQueuesToDistributeFrom(),
        concurrencySet,
        Date.now() + 5_000,
        'SENT_TO_NS',
        1,
      );

      expect(refused).toBeNull();
      expect(await redis.zscore(sourceQueue, second.id)).not.toBeNull();
      expect(await redis.scard(concurrencySet)).toBe(1);
    }
    finally {
      for (const correlationId of [ correlationA, correlationB ]) {
        const leftover = await messageStore.getMessageFromCorrelationId(correlationId);
        if (leftover) {
          await stageStore.messageFullCleanup(leftover, [ sourceQueue, destQueue ]);
        }
      }
      await redis.srem(redisKeys.listOfInitialQueuesToDistributeFrom(), sourceQueue);
      await redis.del(sourceQueue, destQueue, concurrencySet);
    }
  });
});
