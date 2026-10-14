/**
 * Real createIncomingService + thin ingress smoke (Unit 5.5 Step A):
 * enqueue → distribute → sendOne → GW → POST /ingress → cleanup.
 *
 * Opt-in (needs Valkey):
 *
 *   docker compose up -d valkey
 *   pnpm exec vitest run test/integration/incoming-ingress.smoke.spec.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '#src/app.js';
import { deviceMessagingConfigSchema } from '#src/config/schema.js';
import { createBaseService } from '#src/engine/base.js';
import { createInFlightSends } from '#src/engine/in-flight-sends.js';
import { createIncomingService } from '#src/engine/incoming.js';
import { createStageMoves } from '#src/engine/lifecycle/moves.js';
import { STAGES } from '#src/engine/lifecycle/stages.js';
import { createOutgoingService, type OutgoingService } from '#src/engine/outgoing.js';
import { createAdmissionStore } from '#src/lib/redis-repository/admission-store.js';
import { createMessageStore } from '#src/lib/redis-repository/message-store.js';
import { createStageStore } from '#src/lib/redis-repository/stage-store.js';
import { createPluginRegistry } from '#src/plugins/registry.js';
import { STUB_PUSH_ID } from '#src/plugins/stub/index.js';
import { noopMetrics } from '../helpers/noop-metrics.js';
import { purgeMessageReferences } from '../helpers/redis-references.js';
import { waitForPostSend } from '../helpers/wait-for-post-send.js';

const delivery = deviceMessagingConfigSchema.parse({ $schemaVersion: '1' }).delivery;

type IngressStack = {
  readonly app: Awaited<ReturnType<typeof buildApp>>;
  readonly outgoing: OutgoingService;
};

describe('incoming PUSH ingress', () => {
  let redis: typeof import('../../src/lib/redis-repository/client.js').redis;
  let redisKeys: typeof import('../../src/lib/redis-repository/keys.js').redisKeys;

  beforeAll(async () => {
    ({ redis } = await import('../../src/lib/redis-repository/client.js'));
    ({ redisKeys } = await import('../../src/lib/redis-repository/keys.js'));
  });

  afterAll(async () => {
    if (redis) {
      await redis.quit();
    }
  });

  async function startStack(): Promise<IngressStack> {
    const registry = createPluginRegistry([ { id: STUB_PUSH_ID } ]);
    const metrics = noopMetrics;
    const messageStore = createMessageStore({ client: redis });
    const stageStore = createStageStore({ client: redis });
    const moves = createStageMoves({ delivery, metrics, stageStore });
    const baseService = createBaseService({ delivery, metrics, messageStore, moves });
    const inFlightSends = createInFlightSends();
    const outgoing = createOutgoingService({
      registry,
      delivery,
      baseService,
      inFlightSends,
      metrics,
      engineEnabled: false,
      admissionStore: createAdmissionStore({ client: redis }),
      messageStore,
      moves,
    });
    const incomingService = createIncomingService({
      baseService,
      messageStore,
      moves,
      metrics,
    });
    const app = await buildApp({ metrics, incomingService, registry });
    return { app, outgoing };
  }

  it('stub-push: GW → ingress success → message cleaned up', async () => {
    const { app, outgoing } = await startStack();
    const correlationId = `ingress-push-${ Date.now() }`;
    const networkId = 92;
    const queueKey = `queue:stub-push:network:${ networkId }`;

    try {
      const enqueued = await outgoing.enqueue({
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

      await outgoing.distributeToNetworkServers();
      const afterSend = await waitForPostSend(outgoing, correlationId);
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

      const afterAck = await outgoing.getByCorrelationId(correlationId);
      expect(afterAck?.deliveryStatus).toBe('SENT_TO_DEVICE');
      expect(await redis.zscore(STAGES.device.key(), enqueued.id)).not.toBeNull();

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

      const afterSuccess = await outgoing.getByCorrelationId(correlationId);
      expect(afterSuccess).toBeNull();
      expect(await redis.zscore(STAGES.device.key(), enqueued.id)).toBeNull();
    }
    finally {
      const leftover = await outgoing.getByCorrelationId(correlationId);
      if (leftover) {
        await purgeMessageReferences(leftover.id, { correlationId });
      }
      await redis.srem(
        redisKeys.listOfInitialQueuesToDistributeFrom(),
        queueKey,
      );
      await redis.del(redisKeys.lockForQueue(queueKey));
      await app.close();
    }
  });

  it('stub-push: nack while still on the relay-node wait enters retry', async () => {
    const { app, outgoing } = await startStack();
    const correlationId = `ingress-push-nack-${ Date.now() }`;
    const networkId = 93;
    const queueKey = `queue:stub-push:network:${ networkId }`;

    try {
      const enqueued = await outgoing.enqueue({
        commandType: 'READ_CREDIT',
        priority: 1,
        pluginId: STUB_PUSH_ID,
        networkId,
        correlationId,
        device: {
          type: 'ELECTRICITY_METER',
          externalReference: 'ingress-push-nack-meter',
        },
      });

      await outgoing.distributeToNetworkServers();
      const afterSend = await waitForPostSend(outgoing, correlationId);
      expect(afterSend.deliveryQueueId).toMatch(/^stub-ext-/);
      expect(afterSend.deliveryStatus).toBe('DELIVERED_TO_NS');
      expect(await redis.zscore(STAGES.relayNode.key(), enqueued.id)).not.toBeNull();
      const deliveryQueueId = afterSend.deliveryQueueId;

      const nack = await app.inject({
        method: 'POST',
        url: `/ingress/${ STUB_PUSH_ID }`,
        headers: { 'content-type': 'application/json' },
        payload: {
          deliveryQueueId,
          deliveryStatus: 'DELIVERY_FAILED',
          device: enqueued.device,
          failureContext: { reason: 'Downlink not acknowledged by device' },
        },
      });
      expect(nack.statusCode).toBe(204);

      const afterNack = await outgoing.getByCorrelationId(correlationId);
      expect(afterNack?.deliveryStatus).toBe('TO_RETRY');
      expect(await redis.zscore(STAGES.relayNode.key(), enqueued.id)).toBeNull();
      expect(await redis.zscore(STAGES.device.key(), enqueued.id)).toBeNull();
      expect(await redis.zscore(STAGES.retry.key(), enqueued.id)).not.toBeNull();
      expect(
        await redis.exists(redisKeys.indexExternalDeliveryId(deliveryQueueId)),
      ).toBe(0);
    }
    finally {
      const leftover = await outgoing.getByCorrelationId(correlationId);
      if (leftover) {
        await purgeMessageReferences(leftover.id, { correlationId });
      }
      await redis.srem(
        redisKeys.listOfInitialQueuesToDistributeFrom(),
        queueKey,
      );
      await redis.del(redisKeys.lockForQueue(queueKey));
      await app.close();
    }
  });
});
