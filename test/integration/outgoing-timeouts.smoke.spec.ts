/**
 * Stage timeouts driven by the lifecycle runner: NS, relay-node (with and without a
 * remote-status extension) and device. Includes the A3 case — an NS deadline that expires
 * while `sendOne` is still in flight, which must not produce a second send.
 *
 * Opt-in (needs Valkey):
 *
 *   docker compose up -d valkey
 *   RUN_REDIS_SMOKE=1 pnpm exec vitest run test/integration/outgoing-timeouts.smoke.spec.ts
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { deviceMessagingConfigSchema } from '#src/config/schema.js';
import type { LifecycleRunner } from '#src/engine/lifecycle/runner.js';
import { createStageMoves } from '#src/engine/lifecycle/moves.js';
import { QUEUE_NS_KEY, QUEUE_RETRY_KEY, STAGES } from '#src/engine/lifecycle/stages.js';
import type { OutgoingService } from '#src/engine/outgoing.js';
import type { DeviceMessage, DeviceMessageDevice } from '#src/lib/device-message/types.js';
import { redisKeys } from '#src/lib/redis-repository/keys.js';
import { redisRepo } from '#src/lib/redis-repository/index.js';
import { sleep } from '#src/lib/utilities.js';
import { createEngineHarness } from '../helpers/engine-harness.js';
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
  readonly runner: LifecycleRunner;
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

  const { outgoing, runner } = createEngineHarness({ registry, delivery });

  return { outgoing, runner, calls };
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

  it('retries a message whose NS deadline passed with no send in flight', async () => {
    // The deadline's real case. A send this process is still holding suspends it (see the
    // A3 test below), so what remains is a message no send belongs to: left in the ns stage
    // by a process that died, which is how it is staged here.
    const { outgoing, runner } = createHarness({ nsInFlightTimeoutMs: 0 });
    const correlationId = `ns-timeout-${ Date.now() }`;
    const enqueued = await enqueueTracked(outgoing, correlationId);

    await redisRepo.client.zrem(QUEUE_KEY, enqueued.id);
    await redisRepo.client.hset(redisKeys.message(enqueued.id), {
      deliveryStatus: 'SENT_TO_NS',
    });
    await redisRepo.client.zadd(QUEUE_NS_KEY, Date.now() - 1, enqueued.id);

    await runner.tick();

    const parked = await waitForDeliveryStatus(outgoing, correlationId, [ 'TO_RETRY' ]);
    expect(parked.failureHistory?.[0]).toMatchObject({
      reason: 'Timed out waiting for Network Server to accept message',
      isFinal: false,
    });
    expect(await redisRepo.client.zscore(QUEUE_NS_KEY, enqueued.id)).toBeNull();
    expect(await redisRepo.client.zscore(QUEUE_RETRY_KEY, enqueued.id)).not.toBeNull();
  });

  it('holds the NS deadline open while the send is still in flight (A3)', async () => {
    // A3: this used to send twice. The deadline fired while sendOne was still running
    // (observed against CALIN at up to 37s on a 20s deadline), the late success was
    // dropped by the ZREM-gated move, and the retry re-sent the same command to the
    // same meter. The ns row now asks whether this process still holds the send, so
    // with a deadline of 0 the message is rescheduled indefinitely rather than failed
    // — and the slow send, when it lands, still owns its claim (ADR-008 §8).
    let sendCount = 0;
    let releaseFirstSend: ((deliveryQueueId: string) => void) | undefined;
    const firstSend = new Promise<string>(resolve => {
      releaseFirstSend = resolve;
    });

    const { outgoing, runner, calls } = createHarness({
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

    // Two ticks, both finding the deadline long expired, and neither may act on it.
    await runner.tick();
    await runner.tick();

    const stillSending = await outgoing.getByCorrelationId(correlationId);
    expect(stillSending?.deliveryStatus).toBe('SENT_TO_NS');
    expect(await redisRepo.client.zscore(QUEUE_RETRY_KEY, enqueued.id)).toBeNull();
    expect(await redisRepo.client.zscore(QUEUE_NS_KEY, enqueued.id)).not.toBeNull();

    // Shutdown's seam sees the same send the ns row is waiting on.
    expect(await outgoing.drainInFlightSends(10)).toBe(1);

    // The vendor accepts, late. The claim is still ours, so the move commits.
    const lateDeliveryQueueId = `ext-late-${ Date.now() }`;
    releaseFirstSend?.(lateDeliveryQueueId);
    await sleep(SEND_CONTINUATION_MS);

    expect(await redisRepo.client.zscore(STAGES.relayNode.key(), enqueued.id)).not.toBeNull();
    expect(
      await redisRepo.client.exists(redisKeys.indexExternalDeliveryId(lateDeliveryQueueId)),
    ).toBe(1);
    expect(await redisRepo.client.zscore(QUEUE_NS_KEY, enqueued.id)).toBeNull();
    expect(await outgoing.drainInFlightSends(10)).toBe(0);

    // The point of all of it: the meter was commanded once.
    expect(calls.sendOne).toEqual([ enqueued.id ]);
  });

  it('retries a relay-node timeout when the plugin cannot report remote status', async () => {
    const { outgoing, runner } = createHarness();
    const correlationId = `relay-timeout-${ Date.now() }`;
    const enqueued = await sendAndExpireStage(outgoing, correlationId, STAGES.relayNode.key());

    await runner.tick();

    const parked = await waitForDeliveryStatus(outgoing, correlationId, [ 'TO_RETRY' ]);
    expect(parked.failureHistory?.[0]).toMatchObject({
      reason: 'Timed out waiting for relay node to transmit message to device',
    });
    expect(await redisRepo.client.zscore(STAGES.relayNode.key(), enqueued.id)).toBeNull();
  });

  it('extends a relay-node timeout while the network server still holds the command', async () => {
    const { outgoing, runner, calls } = createHarness({
      getRemoteStatus: async () => ({ deliveryStatus: 'QUEUED' }),
    });
    const correlationId = `relay-extend-${ Date.now() }`;
    const enqueued = await sendAndExpireStage(outgoing, correlationId, STAGES.relayNode.key());

    await runner.tick();

    expect(calls.getRemoteStatus).toEqual([ enqueued.id ]);
    const extendedScore = await redisRepo.client.zscore(STAGES.relayNode.key(), enqueued.id);
    expect(Number(extendedScore)).toBeGreaterThan(Date.now());
    expect(await redisRepo.client.zscore(QUEUE_RETRY_KEY, enqueued.id)).toBeNull();

    const stillWaiting = await outgoing.getByCorrelationId(correlationId);
    expect(stillWaiting?.deliveryStatus).toBe('DELIVERED_TO_NS');
  });

  it('retries a device timeout', async () => {
    const { outgoing, runner } = createHarness();
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
    const moves = createStageMoves({ delivery: baseDelivery, metrics: noopMetrics });
    await moves.advance({
      messageId: enqueued.id,
      plugin,
      from: 'relayNode',
    });
    expect(await redisRepo.client.zscore(STAGES.device.key(), enqueued.id)).not.toBeNull();

    await runner.tick();

    const parked = await waitForDeliveryStatus(outgoing, correlationId, [ 'TO_RETRY' ]);
    expect(parked.failureHistory?.[0]).toMatchObject({
      reason: 'Timed out waiting for device response after transmission',
    });
    expect(await redisRepo.client.zscore(STAGES.device.key(), enqueued.id)).toBeNull();
  });
});
