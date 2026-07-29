/**
 * Redis repository smoke test (Unit 2).
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

  afterAll(async () => {
    if (redisRepo) {
      await redisRepo.client.quit();
    }
  });

  it('connects, registers Lua commands, and round-trips a message', async () => {
    ({ redisRepo } = await import('../../src/lib/redis-repository/index.js'));

    expect(await redisRepo.client.ping()).toBe('PONG');
    expect(typeof redisRepo.client.fetchNextMessageInQueueAndMove).toBe('function');
    expect(typeof redisRepo.client.moveMessageBetweenQueues).toBe('function');

    const correlationId = `smoke-${ Date.now() }`;
    const queueKey = `queue:smoke:${ correlationId }`;

    await redisRepo.enqueueDeviceMessage(
      {
        command_type: 'SMOKE_TEST',
        priority: 1,
        pluginId: 'smoke-test',
        network_id: null,
        correlation_id: correlationId,
        device: {
          type: 'ELECTRICITY_METER',
          external_reference: 'smoke-meter',
        },
      },
      queueKey,
    );

    const message = await redisRepo.getMessageFromCorrelationId(correlationId);
    expect(message).not.toBeNull();
    expect(message?.command_type).toBe('SMOKE_TEST');
    expect(message?.pluginId).toBe('smoke-test');
    expect(message?.network_id).toBeNull();
    expect(message?.delivery_status).toBe('QUEUED');

    await redisRepo.messageFullCleanup(message!, {
      inFlightQueueKeys: [ queueKey ],
    });

    expect(await redisRepo.getMessageFromCorrelationId(correlationId)).toBeNull();
    expect(await redisRepo.client.zcard(queueKey)).toBe(0);
  });
});
