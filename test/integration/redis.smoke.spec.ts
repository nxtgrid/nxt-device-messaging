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
  let redisRepo: typeof import('../../src/lib/redis-repository/index.js').redisRepo;
  let redisKeys: typeof import('../../src/lib/redis-repository/keys.js').redisKeys;

  afterAll(async () => {
    if (redisRepo) {
      await redisRepo.client.quit();
    }
  });

  it('connects, registers Lua commands, and round-trips a message', async () => {
    ({ redisRepo } = await import('../../src/lib/redis-repository/index.js'));
    ({ redisKeys } = await import('../../src/lib/redis-repository/keys.js'));

    expect(await redisRepo.client.ping()).toBe('PONG');
    expect(typeof redisRepo.client.fetchNextMessageInQueueAndMove).toBe('function');
    expect(typeof redisRepo.client.moveMessageBetweenQueues).toBe('function');

    const correlationId = `smoke-${ Date.now() }`;
    const queueKey = `queue:smoke:${ correlationId }`;

    const enqueued = await redisRepo.enqueueDeviceMessage(
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
    );

    expect(enqueued.commandType).toBe('READ_CREDIT');
    expect(enqueued.deliveryStatus).toBe('QUEUED');

    const message = await redisRepo.getMessageFromCorrelationId(correlationId);
    expect(message).not.toBeNull();
    expect(message?.commandType).toBe('READ_CREDIT');
    expect(message?.pluginId).toBe('smoke-test');
    expect(message?.networkId).toBeNull();
    expect(message?.deliveryStatus).toBe('QUEUED');
    expect(message?.device.externalReference).toBe('smoke-meter');

    await redisRepo.messageFullCleanup(message!, {
      inFlightQueueKeys: [ queueKey ],
    });

    // messageFullCleanup does not SREM queues_to_distribute_from — the distributor Lua
    // GC's that when a queue empties. Smoke has no distribute pass, so tidy explicitly.
    await redisRepo.client.srem(
      redisKeys.listOfInitialQueuesToDistributeFrom(),
      queueKey,
    );

    expect(await redisRepo.getMessageFromCorrelationId(correlationId)).toBeNull();
    expect(await redisRepo.client.zcard(queueKey)).toBe(0);
    expect(await redisRepo.client.sismember(
      redisKeys.listOfInitialQueuesToDistributeFrom(),
      queueKey,
    )).toBe(0);
  });
});
