/**
 * Stage timeouts driven by the resolution cycle: NS, relay-node (with and without a
 * remote-status extension) and device. Includes the A3 case where the NS deadline
 * fires while `sendOne` is still in flight.
 *
 * Opt-in (needs Valkey):
 *
 *   docker compose up -d valkey
 *   RUN_REDIS_SMOKE=1 pnpm exec vitest run test/integration/outgoing-timeouts.smoke.spec.ts
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { deviceMessagingConfigSchema } from '#src/config/schema.js';
import { createBaseService } from '#src/engine/base.js';
import { createStageMoves } from '#src/engine/lifecycle/moves.js';
import { QUEUE_NS_KEY, QUEUE_RETRY_KEY, STAGES } from '#src/engine/lifecycle/stages.js';
import { createOutgoingService, type OutgoingService } from '#src/engine/outgoing.js';
import type { DeviceMessage, DeviceMessageDevice } from '#src/lib/device-message/types.js';
import { redisKeys } from '#src/lib/redis-repository/keys.js';
import { redisRepo } from '#src/lib/redis-repository/index.js';
import { sleep } from '#src/lib/utilities.js';
import { noopMetrics } from '../helpers/noop-metrics.js';
import {
  createProgrammablePlugin,
  type ProgrammablePluginCalls,
} from '../helpers/programmable-plugin.js';
import {
  purgeExternalDeliveryIndexes,
  purgeInitialQueue,
  purgeMessageReferences,
} from '../helpers/redis-references.js';
import { waitForDeliveryStatus } from '../helpers/wait-for.js';

const shouldRun = process.env.RUN_REDIS_SMOKE === '1';
const baseDelivery = deviceMessagingConfigSchema.parse({ $schemaVersion: '1' }).delivery;

const PLUGIN_ID = 'smoke-timeout-push';
const NETWORK_ID = 502;
/** Grace for the fire-and-forget send continuation to run after it resolves. */
const SEND_CONTINUATION_MS = 100;

const DEVICE: DeviceMessageDevice = {
  type: 'ELECTRICITY_METER',
  externalReference: 'smoke-timeout-meter',
};

const QUEUE_KEY = createProgrammablePlugin({
  id: PLUGIN_ID,
  deliveryPattern: 'PUSH',
}).initialQueueKey({ networkId: NETWORK_ID, device: DEVICE });

type Harness = {
  readonly outgoing: OutgoingService;
  readonly calls: ProgrammablePluginCalls;
};

function createHarness(options: {
  readonly sendOne?: (message: DeviceMessage) => Promise<string>;
  readonly getRemoteStatus?: (
    message: DeviceMessage,
  ) => Promise<{ readonly deliveryStatus: string }>;
  readonly nsInFlightTimeoutMs?: number;
  readonly retryBaseDelayMs?: number;
} = {}): Harness {
  const delivery = {
    ...baseDelivery,
    ...(options.retryBaseDelayMs !== undefined && { retryBaseDelayMs: options.retryBaseDelayMs }),
  };
  const { registry, calls } = createProgrammablePlugin({
    id: PLUGIN_ID,
    deliveryPattern: 'PUSH',
    sendOne: options.sendOne,
    getRemoteStatus: options.getRemoteStatus,
    ...(options.nsInFlightTimeoutMs !== undefined && {
      tuning: { nsInFlightTimeoutMs: options.nsInFlightTimeoutMs },
    }),
  });

  const metrics = noopMetrics;
  const outgoing = createOutgoingService({
    registry,
    delivery,
    baseService: createBaseService({ registry, delivery, metrics }),
    metrics,
    kickDistributeOnEnqueue: false,
  });

  return { outgoing, calls };
}

const trash: Array<{ readonly id: string; readonly correlationId: string }> = [];

async function enqueueTracked(
  outgoing: OutgoingService,
  correlationId: string,
): Promise<DeviceMessage> {
  const message = await outgoing.enqueue({
    commandType: 'READ_CREDIT',
    priority: 1,
    pluginId: PLUGIN_ID,
    networkId: NETWORK_ID,
    correlationId,
    device: DEVICE,
  });
  trash.push({ id: message.id, correlationId });
  return message;
}

/** Send, then force the message's stage deadline into the past. */
async function sendAndExpireStage(
  outgoing: OutgoingService,
  correlationId: string,
  stageQueueKey: string,
): Promise<DeviceMessage> {
  const enqueued = await enqueueTracked(outgoing, correlationId);
  await outgoing.distributeToNetworkServers();
  await waitForDeliveryStatus(outgoing, correlationId, [ 'DELIVERED_TO_NS' ]);
  await redisRepo.client.zadd(stageQueueKey, Date.now() - 1, enqueued.id);
  return enqueued;
}

describe.skipIf(!shouldRun)('outgoing stage timeouts', () => {
  afterEach(async () => {
    for (const { id, correlationId } of trash) {
      await purgeMessageReferences(id, { correlationId });
    }
    trash.length = 0;
    await purgeInitialQueue(QUEUE_KEY);
    await purgeExternalDeliveryIndexes('ext-');
  });

  afterAll(async () => {
    await redisRepo.client.quit();
  });

  it('retries a message whose NS deadline passed', async () => {
    const { outgoing } = createHarness({
      nsInFlightTimeoutMs: 0,
      // Never resolves: the message sits in the NS stage for the whole test.
      sendOne: () => new Promise<string>(() => {}),
    });
    const correlationId = `ns-timeout-${ Date.now() }`;
    const enqueued = await enqueueTracked(outgoing, correlationId);

    await outgoing.distributeToNetworkServers();
    expect(await redisRepo.client.zscore(QUEUE_NS_KEY, enqueued.id)).not.toBeNull();

    await outgoing.runMessageResolutionCycle();

    const parked = await waitForDeliveryStatus(outgoing, correlationId, [ 'TO_RETRY' ]);
    expect(parked.failureHistory?.[0]).toMatchObject({
      reason: 'Timed out waiting for Network Server to accept message',
      isFinal: false,
    });
    expect(await redisRepo.client.zscore(QUEUE_NS_KEY, enqueued.id)).toBeNull();
    expect(await redisRepo.client.zscore(QUEUE_RETRY_KEY, enqueued.id)).not.toBeNull();
  });

  it('sends twice when a slow send lands after its NS deadline expired', async () => {
    // A3: the NS deadline fires while sendOne is still in flight (observed against
    // CALIN at up to 37s on a 20s deadline). The late success is silently dropped
    // because the Lua move is ZREM-gated, so the vendor gets the command twice.
    // When the stage table lands, that dropped move must become observable and this
    // test should assert one send, or an explicit duplicate-detected outcome.
    let sendCount = 0;
    let releaseFirstSend: ((deliveryQueueId: string) => void) | undefined;
    const firstSend = new Promise<string>(resolve => {
      releaseFirstSend = resolve;
    });

    const { outgoing, calls } = createHarness({
      nsInFlightTimeoutMs: 0,
      retryBaseDelayMs: 10,
      sendOne: async () => {
        sendCount += 1;
        return sendCount === 1 ? firstSend : `ext-second-${ Date.now() }`;
      },
    });
    const correlationId = `ns-slow-send-${ Date.now() }`;
    const enqueued = await enqueueTracked(outgoing, correlationId);

    await outgoing.distributeToNetworkServers();
    await outgoing.runMessageResolutionCycle();
    await waitForDeliveryStatus(outgoing, correlationId, [ 'TO_RETRY' ]);

    // The vendor now accepts the command the service has already given up on.
    const lateDeliveryQueueId = `ext-late-${ Date.now() }`;
    releaseFirstSend?.(lateDeliveryQueueId);
    await sleep(SEND_CONTINUATION_MS);

    // Dropped without a trace: no stage move, no index, no status change.
    expect(await redisRepo.client.zscore(STAGES.relayNode.key(), enqueued.id)).toBeNull();
    expect(
      await redisRepo.client.exists(redisKeys.indexExternalDeliveryId(lateDeliveryQueueId)),
    ).toBe(0);
    expect(await redisRepo.client.zscore(QUEUE_RETRY_KEY, enqueued.id)).not.toBeNull();

    // And the retry re-sends the same command to the same device.
    await sleep(40);
    await outgoing.runMessageResolutionCycle();
    await waitForDeliveryStatus(outgoing, correlationId, [ 'DELIVERED_TO_NS' ]);
    expect(calls.sendOne).toEqual([ enqueued.id, enqueued.id ]);
  });

  it('retries a relay-node timeout when the plugin cannot report remote status', async () => {
    const { outgoing } = createHarness();
    const correlationId = `relay-timeout-${ Date.now() }`;
    const enqueued = await sendAndExpireStage(outgoing, correlationId, STAGES.relayNode.key());

    await outgoing.runMessageResolutionCycle();

    const parked = await waitForDeliveryStatus(outgoing, correlationId, [ 'TO_RETRY' ]);
    expect(parked.failureHistory?.[0]).toMatchObject({
      reason: 'Timed out waiting for relay node to transmit message to device',
    });
    expect(await redisRepo.client.zscore(STAGES.relayNode.key(), enqueued.id)).toBeNull();
  });

  it('extends a relay-node timeout while the network server still holds the command', async () => {
    const { outgoing, calls } = createHarness({
      getRemoteStatus: async () => ({ deliveryStatus: 'QUEUED' }),
    });
    const correlationId = `relay-extend-${ Date.now() }`;
    const enqueued = await sendAndExpireStage(outgoing, correlationId, STAGES.relayNode.key());

    await outgoing.runMessageResolutionCycle();

    expect(calls.getRemoteStatus).toEqual([ enqueued.id ]);
    const extendedScore = await redisRepo.client.zscore(STAGES.relayNode.key(), enqueued.id);
    expect(Number(extendedScore)).toBeGreaterThan(Date.now());
    expect(await redisRepo.client.zscore(QUEUE_RETRY_KEY, enqueued.id)).toBeNull();

    const stillWaiting = await outgoing.getByCorrelationId(correlationId);
    expect(stillWaiting?.deliveryStatus).toBe('DELIVERED_TO_NS');
  });

  it('retries a device timeout', async () => {
    const { outgoing } = createHarness();
    const correlationId = `device-timeout-${ Date.now() }`;
    const enqueued = await enqueueTracked(outgoing, correlationId);

    await outgoing.distributeToNetworkServers();
    await waitForDeliveryStatus(outgoing, correlationId, [ 'DELIVERED_TO_NS' ]);

    // Relay-node ACK moves the message on, with an already-elapsed device deadline.
    const { plugin } = createProgrammablePlugin({
      id: PLUGIN_ID,
      deliveryPattern: 'PUSH',
      tuning: { deviceInFlightTimeoutMs: 0 },
    });
    const moves = createStageMoves({ delivery: baseDelivery });
    await moves.advance({
      messageId: enqueued.id,
      plugin,
      from: 'relayNode',
    });
    expect(await redisRepo.client.zscore(STAGES.device.key(), enqueued.id)).not.toBeNull();

    await outgoing.runMessageResolutionCycle();

    const parked = await waitForDeliveryStatus(outgoing, correlationId, [ 'TO_RETRY' ]);
    expect(parked.failureHistory?.[0]).toMatchObject({
      reason: 'Timed out waiting for device response after transmission',
    });
    expect(await redisRepo.client.zscore(STAGES.device.key(), enqueued.id)).toBeNull();
  });
});
