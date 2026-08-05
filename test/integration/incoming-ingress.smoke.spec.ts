/**
 * Real createIncomingService + thin ingress smoke (Unit 5.5 Step A):
 * enqueue → distribute → sendOne → GW → POST /ingress → cleanup.
 *
 * Opt-in (needs Valkey):
 *
 *   docker compose up -d valkey
 *   RUN_REDIS_SMOKE=1 pnpm exec vitest run test/integration/incoming-ingress.smoke.spec.ts
 */
import { afterAll, describe, expect, it } from 'vitest';

import { buildApp } from '#src/app.js';
import { deviceMessagingConfigSchema } from '#src/config/schema.js';
import { createBaseService } from '#src/engine/base.js';
import { createIncomingService } from '#src/engine/incoming.js';
import { createOutgoingService } from '#src/engine/outgoing.js';
import { QUEUE_DEVICE_KEY } from '#src/lib/queue-moving.push.js';
import { createPluginRegistry } from '#src/plugins/registry.js';
import { STUB_PUSH_ID } from '#src/plugins/stub/index.js';
import { waitForPostSend } from '../helpers/wait-for-post-send.js';

const shouldRun = process.env.RUN_REDIS_SMOKE === '1';
const delivery = deviceMessagingConfigSchema.parse({ $schemaVersion: '1' }).delivery;

describe.skipIf(!shouldRun)('incoming PUSH ingress', () => {
  let redisRepo: typeof import('../../src/lib/redis-repository/index.js').redisRepo;
  let redisKeys: typeof import('../../src/lib/redis-repository/keys.js').redisKeys;

  afterAll(async () => {
    if (redisRepo) {
      await redisRepo.client.quit();
    }
  });

  it('stub-push: GW → ingress success → message cleaned up', async () => {
    ({ redisRepo } = await import('../../src/lib/redis-repository/index.js'));
    ({ redisKeys } = await import('../../src/lib/redis-repository/keys.js'));

    const registry = createPluginRegistry([ { id: STUB_PUSH_ID } ]);
    const baseService = createBaseService({ registry, delivery });
    const outgoingService = createOutgoingService({
      registry,
      delivery,
      baseService,
      kickDistributeOnEnqueue: false,
    });
    const incomingService = createIncomingService({ registry, delivery, baseService });
    const app = await buildApp({ incomingService, registry });

    const correlationId = `ingress-push-${ Date.now() }`;
    const networkId = 92;
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
          externalReference: 'ingress-push-meter',
        },
      });

      await outgoingService.distributeToNetworkServers();
      const afterSend = await waitForPostSend(outgoingService, correlationId);
      expect(afterSend.deliveryQueueId).toMatch(/^stub-ext-/);
      const deliveryQueueId = afterSend.deliveryQueueId;

      const ack = await app.inject({
        method: 'POST',
        url: `/ingress/${ STUB_PUSH_ID }`,
        headers: { 'content-type': 'application/json' },
        payload: {
          deliveryQueueId,
          deliveryStatus: 'SENT_TO_DEVICE',
          device: enqueued.device,
        },
      });
      expect(ack.statusCode).toBe(204);

      const afterAck = await outgoingService.getByCorrelationId(correlationId);
      expect(afterAck?.deliveryStatus).toBe('SENT_TO_DEVICE');
      expect(await redisRepo.client.zscore(QUEUE_DEVICE_KEY, enqueued.id)).not.toBeNull();

      const success = await app.inject({
        method: 'POST',
        url: `/ingress/${ STUB_PUSH_ID }`,
        headers: { 'content-type': 'application/json' },
        payload: {
          deliveryQueueId,
          deliveryStatus: 'DELIVERY_SUCCESSFUL',
          device: enqueued.device,
          response: { status: 'EXECUTION_SUCCESS' },
        },
      });
      expect(success.statusCode).toBe(204);

      const afterSuccess = await outgoingService.getByCorrelationId(correlationId);
      expect(afterSuccess).toBeNull();
      expect(await redisRepo.client.zscore(QUEUE_DEVICE_KEY, enqueued.id)).toBeNull();
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
      await app.close();
    }
  });
});
