/**
 * Every outcome of a PULL status poll: still pending, vendor error, success, and a
 * reported execution failure. The happy path through `runner.tick` is covered by
 * `incoming-poll.smoke.spec.ts`; this file covers what happens when it is not happy.
 *
 * Opt-in (needs Valkey):
 *
 *   docker compose up -d valkey
 *   RUN_REDIS_SMOKE=1 pnpm exec vitest run test/integration/incoming-poll-outcomes.smoke.spec.ts
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { deviceMessagingConfigSchema } from '#src/config/schema.js';
import type { LifecycleRunner } from '#src/engine/lifecycle/runner.js';
import { QUEUE_RETRY_KEY } from '#src/engine/lifecycle/stages.js';
import type { OutgoingService } from '#src/engine/outgoing.js';
import type {
  DeviceMessage,
  DeviceMessageDevice,
  ParsedIncomingEvent,
} from '#src/lib/device-message/types.js';
import { redis } from '#src/lib/redis-repository/client.js';
import { redisKeys } from '#src/lib/redis-repository/keys.js';
import { sleep } from '#src/lib/utilities.js';
import { buildConcurrencyRateLimitKey } from '#src/plugins/_shared/initial-queue-key.js';
import { createEngineHarness } from '../helpers/engine-harness.js';
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
  readonly runner: LifecycleRunner;
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
  const { outgoing, runner } = createEngineHarness({
    registry,
    delivery,
    webhook: recorder.webhook,
  });

  return {
    recorder,
    calls,
    outgoing,
    runner,
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
    await redis.quit();
  });

  it('pushes out the next poll time while the vendor is still working', async () => {
    const { outgoing, runner, calls } = createHarness(async () => null);
    const correlationId = `poll-pending-${ Date.now() }`;
    const enqueued = await enqueueAndAwaitTask(outgoing, correlationId);

    await runner.tick();

    expect(calls.fetchStatus).toEqual([ enqueued.id ]);
    const nextPollAt = Number(await redis.zscore(AWAITING_TASK_KEY, enqueued.id));
    expect(nextPollAt).toBeGreaterThan(Date.now() + PENDING_POLL_DELAY_MS - 1_000);
    expect(nextPollAt).toBeLessThan(Date.now() + PENDING_POLL_DELAY_MS + 1_000);
  });

  it('advances the score when the vendor is unreachable (A2)', async () => {
    // A throwing vendor is not evidence about the message, so the member keeps its place
    // and comes back on the ladder. Advancing the score on this branch too is what stops
    // one unreachable vendor from being re-polled every tick forever — and, because the
    // throw no longer escapes the loop, from starving the messages behind it in the queue.
    const { outgoing, runner } = createHarness(async () => {
      throw new Error('vendor unreachable');
    });
    const correlationId = `poll-error-${ Date.now() }`;
    const enqueued = await enqueueAndAwaitTask(outgoing, correlationId);
    const dueBefore = Number(await redis.zscore(AWAITING_TASK_KEY, enqueued.id));

    await runner.tick();

    const dueAfter = Number(await redis.zscore(AWAITING_TASK_KEY, enqueued.id));
    expect(dueAfter).toBeGreaterThan(dueBefore);
    expect(dueAfter).toBeGreaterThan(Date.now() + PENDING_POLL_DELAY_MS - 1_000);
  });

  it('cleans up, notifies and releases the slot on a successful poll', async () => {
    const { outgoing, runner, recorder } = createHarness(async message => ({
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

    await runner.tick();

    expect(recorder.withStatus('DELIVERY_SUCCESSFUL')).toHaveLength(1);
    expect(await findMessageReferences(enqueued.id, { correlationId, deliveryQueueId }))
      .toEqual([]);
  });

  it('retries and releases the slot when the vendor reports a failed execution', async () => {
    const { outgoing, runner } = createHarness(async message => ({
      deliveryQueueId: message.deliveryQueueId,
      deliveryStatus: 'DELIVERY_FAILED',
      device: message.device,
      failureContext: { reason: 'meter rejected the command' },
    }));
    const correlationId = `poll-failed-${ Date.now() }`;
    const enqueued = await enqueueAndAwaitTask(outgoing, correlationId);
    expect(await redis.sismember(RATE_LIMIT_KEY, enqueued.id)).toBe(1);

    await runner.tick();

    const parked = await waitForDeliveryStatus(outgoing, correlationId, [ 'TO_RETRY' ]);
    expect(parked.failureHistory?.[0]).toMatchObject({
      reason: 'meter rejected the command',
      isFinal: false,
    });
    expect(await redis.zscore(AWAITING_TASK_KEY, enqueued.id)).toBeNull();
    expect(await redis.zscore(QUEUE_RETRY_KEY, enqueued.id)).not.toBeNull();
    // A held concurrency slot would cap the plugin's throughput forever.
    expect(await redis.sismember(RATE_LIMIT_KEY, enqueued.id)).toBe(0);
  });
});
