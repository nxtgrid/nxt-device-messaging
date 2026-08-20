/**
 * Every outcome of a PULL status poll: still pending, vendor error, success, and a
 * reported execution failure. The happy path through `pollPullPlugins` is covered by
 * `incoming-poll.smoke.spec.ts`; this file covers what happens when it is not happy.
 *
 * Opt-in (needs Valkey):
 *
 *   docker compose up -d valkey
 *   RUN_REDIS_SMOKE=1 pnpm exec vitest run test/integration/incoming-poll-outcomes.smoke.spec.ts
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { deviceMessagingConfigSchema } from '#src/config/schema.js';
import { createBaseService } from '#src/engine/base.js';
import { createIncomingService, type IncomingService } from '#src/engine/incoming.js';
import { createOutgoingService, type OutgoingService } from '#src/engine/outgoing.js';
import type {
  DeviceMessage,
  DeviceMessageDevice,
  ParsedIncomingEvent,
} from '#src/lib/device-message/types.js';
import { QUEUE_RETRY_KEY } from '#src/lib/queue-moving.js';
import { redisKeys } from '#src/lib/redis-repository/keys.js';
import { redisRepo } from '#src/lib/redis-repository/index.js';
import { sleep } from '#src/lib/utilities.js';
import { buildConcurrencyRateLimitKey } from '#src/plugins/_shared/initial-queue-key.js';
import { noopMetrics } from '../helpers/noop-metrics.js';
import {
  createProgrammablePlugin,
  type ProgrammablePluginCalls,
} from '../helpers/programmable-plugin.js';
import {
  findMessageReferences,
  purgeExternalDeliveryIndexes,
  purgeInitialQueue,
  purgeMessageReferences,
} from '../helpers/redis-references.js';
import { createWebhookRecorder, type WebhookRecorder } from '../helpers/webhook-recorder.js';
import { waitForDeliveryStatus } from '../helpers/wait-for.js';

const shouldRun = process.env.RUN_REDIS_SMOKE === '1';
const baseDelivery = deviceMessagingConfigSchema.parse({ $schemaVersion: '1' }).delivery;

const PLUGIN_ID = 'smoke-poll-pull';
const RELAY_NODE_ID = 31;
const AWAITING_TASK_KEY = redisKeys.queueAwaitingTask(PLUGIN_ID);
/** First poll becomes due almost immediately, so specs need no real wait. */
const INITIAL_POLL_DELAY_MS = 1;
/** `getNextPollDelay` for a message younger than 20s. */
const PENDING_POLL_DELAY_MS = 10_000;

const DEVICE: DeviceMessageDevice = {
  type: 'ELECTRICITY_METER',
  externalReference: 'smoke-poll-meter',
  relayNode: { id: RELAY_NODE_ID },
};

const QUEUE_KEY = createProgrammablePlugin({
  id: PLUGIN_ID,
  deliveryPattern: 'PULL',
}).initialQueueKey({ device: DEVICE, networkId: null });
const RATE_LIMIT_KEY = buildConcurrencyRateLimitKey(QUEUE_KEY);
if (RATE_LIMIT_KEY === undefined) {
  throw new Error(`expected a concurrency rate-limit key for ${ QUEUE_KEY }`);
}

type Harness = {
  readonly outgoing: OutgoingService;
  readonly incoming: IncomingService;
  readonly recorder: WebhookRecorder;
  readonly calls: ProgrammablePluginCalls;
};

function createHarness(
  fetchStatus: (message: DeviceMessage) => Promise<ParsedIncomingEvent | null>,
): Harness {
  const delivery = baseDelivery;
  const { registry, calls } = createProgrammablePlugin({
    id: PLUGIN_ID,
    deliveryPattern: 'PULL',
    tuning: { initialPollDelayMs: INITIAL_POLL_DELAY_MS },
    fetchStatus,
  });
  const recorder = createWebhookRecorder();
  const metrics = noopMetrics;
  const baseService = createBaseService({
    registry,
    delivery,
    webhook: recorder.webhook,
    metrics,
  });

  return {
    recorder,
    calls,
    outgoing: createOutgoingService({
      registry,
      delivery,
      baseService,
      metrics,
      kickDistributeOnEnqueue: false,
    }),
    incoming: createIncomingService({ registry, delivery, baseService, metrics }),
  };
}

const trash: Array<{ readonly id: string; readonly correlationId: string }> = [];

/** Enqueue, send, and wait until the message is parked awaiting its vendor task. */
async function enqueueAndAwaitTask(
  outgoing: OutgoingService,
  correlationId: string,
): Promise<DeviceMessage> {
  const enqueued = await outgoing.enqueue({
    commandType: 'READ_CREDIT',
    priority: 1,
    pluginId: PLUGIN_ID,
    networkId: null,
    correlationId,
    device: DEVICE,
  });
  trash.push({ id: enqueued.id, correlationId });

  await outgoing.distributeToNetworkServers();
  await waitForDeliveryStatus(outgoing, correlationId, [ 'DELIVERED_TO_NS' ]);
  // The first poll is due `INITIAL_POLL_DELAY_MS` after the move.
  await sleep(INITIAL_POLL_DELAY_MS + 5);
  return enqueued;
}

describe.skipIf(!shouldRun)('incoming poll outcomes', () => {
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

  it('pushes out the next poll time while the vendor is still working', async () => {
    const { outgoing, incoming, calls } = createHarness(async () => null);
    const correlationId = `poll-pending-${ Date.now() }`;
    const enqueued = await enqueueAndAwaitTask(outgoing, correlationId);

    await incoming.pollPullPlugins();

    expect(calls.fetchStatus).toEqual([ enqueued.id ]);
    const nextPollAt = Number(await redisRepo.client.zscore(AWAITING_TASK_KEY, enqueued.id));
    expect(nextPollAt).toBeGreaterThan(Date.now() + PENDING_POLL_DELAY_MS - 1_000);
    expect(nextPollAt).toBeLessThan(Date.now() + PENDING_POLL_DELAY_MS + 1_000);
  });

  it('re-polls a vendor error on every tick without advancing the score (A2)', async () => {
    // A2: the score is only advanced on the "still pending" branch, so a throwing
    // fetchStatus leaves the message due forever — and because the error escapes
    // `pollAwaitingTasksFor`, it also aborts the batch, starving every message behind
    // it in the same queue. The stage table must advance the score on every branch.
    const { outgoing, incoming } = createHarness(async () => {
      throw new Error('vendor unreachable');
    });
    const correlationId = `poll-error-${ Date.now() }`;
    const enqueued = await enqueueAndAwaitTask(outgoing, correlationId);
    const dueBefore = await redisRepo.client.zscore(AWAITING_TASK_KEY, enqueued.id);

    await expect(incoming.pollPullPlugins()).rejects.toThrow('vendor unreachable');

    expect(await redisRepo.client.zscore(AWAITING_TASK_KEY, enqueued.id)).toBe(dueBefore);
  });

  it('cleans up, notifies and releases the slot on a successful poll', async () => {
    const { outgoing, incoming, recorder } = createHarness(async message => ({
      deliveryQueueId: message.deliveryQueueId,
      deliveryStatus: 'DELIVERY_SUCCESSFUL',
      device: message.device,
      response: { status: 'EXECUTION_SUCCESS' },
    }));
    const correlationId = `poll-success-${ Date.now() }`;
    const enqueued = await enqueueAndAwaitTask(outgoing, correlationId);
    const { deliveryQueueId } = await waitForDeliveryStatus(
      outgoing,
      correlationId,
      [ 'DELIVERED_TO_NS' ],
    );

    await incoming.pollPullPlugins();

    expect(recorder.withStatus('DELIVERY_SUCCESSFUL')).toHaveLength(1);
    expect(await findMessageReferences(enqueued.id, { correlationId, deliveryQueueId }))
      .toEqual([]);
  });

  it('retries and releases the slot when the vendor reports a failed execution', async () => {
    const { outgoing, incoming } = createHarness(async message => ({
      deliveryQueueId: message.deliveryQueueId,
      deliveryStatus: 'DELIVERY_FAILED',
      device: message.device,
      failureContext: { reason: 'meter rejected the command' },
    }));
    const correlationId = `poll-failed-${ Date.now() }`;
    const enqueued = await enqueueAndAwaitTask(outgoing, correlationId);
    expect(await redisRepo.client.sismember(RATE_LIMIT_KEY, enqueued.id)).toBe(1);

    await incoming.pollPullPlugins();

    const parked = await waitForDeliveryStatus(outgoing, correlationId, [ 'TO_RETRY' ]);
    expect(parked.failureHistory?.[0]).toMatchObject({
      reason: 'meter rejected the command',
      isFinal: false,
    });
    expect(await redisRepo.client.zscore(AWAITING_TASK_KEY, enqueued.id)).toBeNull();
    expect(await redisRepo.client.zscore(QUEUE_RETRY_KEY, enqueued.id)).not.toBeNull();
    // A held concurrency slot would cap the plugin's throughput forever.
    expect(await redisRepo.client.sismember(RATE_LIMIT_KEY, enqueued.id)).toBe(0);
  });
});
