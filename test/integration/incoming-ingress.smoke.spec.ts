/**
 * Real createIncoming + thin ingress smoke (Unit 5.5 Step A):
 * enqueue → distribute → sendOne → GW → POST /ingress → cleanup.
 *
 * Opt-in (needs Valkey):
 *
 *   docker compose up -d valkey
 *   RUN_REDIS_SMOKE=1 pnpm exec vitest run test/integration/incoming-ingress.smoke.spec.ts
 */
import { afterAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { deviceMessagingConfigSchema } from '../../src/config/schema.js';
import { createBase } from '../../src/engine/base.js';
import { createIncoming } from '../../src/engine/incoming.js';
import { createOutgoing, type Outgoing } from '../../src/engine/outgoing.js';
import type { DeviceMessage } from '../../src/lib/device-message/types.js';
import { QUEUE_DEVICE_KEY } from '../../src/lib/queue-moving.push.js';
import { sleep } from '../../src/lib/utilities.js';
import { createPluginRegistry } from '../../src/plugins/registry.js';
import { STUB_PUSH_ID } from '../../src/plugins/stub/index.js';

const shouldRun = process.env.RUN_REDIS_SMOKE === '1';
const delivery = deviceMessagingConfigSchema.parse({ $schemaVersion: '1' }).delivery;

const POST_SEND_STATUS = 'DELIVERED_TO_NS' as const;
const STUB_DELIVERY_ID = 'stub-ext-id';

async function waitForPostSend(
  outgoing: Outgoing,
  correlationId: string,
  timeoutMs = 2_000,
): Promise<DeviceMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = await outgoing.getByCorrelationId(correlationId);
    if (message?.deliveryStatus === POST_SEND_STATUS) return message;
    await sleep(20);
  }
  throw new Error(
    `Timed out waiting for ${ POST_SEND_STATUS } (correlationId=${ correlationId })`,
  );
}

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
    const base = createBase({ registry, delivery });
    const outgoing = createOutgoing({
      registry,
      delivery,
      base,
      kickDistributeOnEnqueue: false,
    });
    const incoming = createIncoming({ registry, delivery, base });
    const app = await buildApp({ outgoing, incoming, registry });

    const correlationId = `ingress-push-${ Date.now() }`;
    const networkId = 92;
    const queueKey = `queue:stub-push:network:${ networkId }`;

    const enqueued = await outgoing.enqueue({
      commandType: 'READ',
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
    expect(afterSend.deliveryQueueId).toBe(STUB_DELIVERY_ID);

    const ack = await app.inject({
      method: 'POST',
      url: `/ingress/${ STUB_PUSH_ID }`,
      headers: { 'content-type': 'application/json' },
      payload: {
        deliveryQueueId: STUB_DELIVERY_ID,
        deliveryStatus: 'SENT_TO_DEVICE',
        device: enqueued.device,
      },
    });
    expect(ack.statusCode).toBe(204);

    const afterAck = await outgoing.getByCorrelationId(correlationId);
    expect(afterAck?.deliveryStatus).toBe('SENT_TO_DEVICE');
    expect(await redisRepo.client.zscore(QUEUE_DEVICE_KEY, enqueued.id)).not.toBeNull();

    const success = await app.inject({
      method: 'POST',
      url: `/ingress/${ STUB_PUSH_ID }`,
      headers: { 'content-type': 'application/json' },
      payload: {
        deliveryQueueId: STUB_DELIVERY_ID,
        deliveryStatus: 'DELIVERY_SUCCESSFUL',
        device: enqueued.device,
        response: { status: 'EXECUTION_SUCCESS' },
      },
    });
    expect(success.statusCode).toBe(204);

    const afterSuccess = await outgoing.getByCorrelationId(correlationId);
    expect(afterSuccess).toBeNull();
    expect(await redisRepo.client.zscore(QUEUE_DEVICE_KEY, enqueued.id)).toBeNull();

    await redisRepo.client.srem(
      redisKeys.listOfInitialQueuesToDistributeFrom(),
      queueKey,
    );
    await redisRepo.client.del(redisKeys.lockForQueue(queueKey));
    await app.close();
  });
});
