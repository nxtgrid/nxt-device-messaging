/**
 * Two invariants the stage-table refactor must not regress:
 *
 * 1. **Orphan scrubbing** — a queue member whose hash is gone must not stay forever.
 * 2. **Cleanup completeness** — a message that ends leaves no Redis reference behind.
 *
 * Both were first written against the pre-refactor behaviour, gaps included, so that the
 * stage table's diff would show exactly which assertions it fixed. They now assert the
 * fixed behaviour (A1, A2, A4).
 *
 * Opt-in (needs Valkey):
 *
 *   docker compose up -d valkey
 *   RUN_REDIS_SMOKE=1 pnpm exec vitest run test/integration/lifecycle-orphans-and-cleanup.smoke.spec.ts
 */
import { ulid } from 'ulid';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { deviceMessagingConfigSchema } from '#src/config/schema.js';
import type { LifecycleRunner } from '#src/engine/lifecycle/runner.js';
import { createStageMoves } from '#src/engine/lifecycle/moves.js';
import { QUEUE_NS_KEY, QUEUE_RETRY_KEY, STAGES } from '#src/engine/lifecycle/stages.js';
import type { OutgoingService } from '#src/engine/outgoing.js';
import type { DeviceMessage, DeviceMessageDevice } from '#src/lib/device-message/types.js';
import { redis } from '#src/lib/redis-repository/client.js';
import { redisKeys } from '#src/lib/redis-repository/keys.js';
import { createStageStore } from '#src/lib/redis-repository/stage-store.js';
import { createEngineHarness } from '../helpers/engine-harness.js';
import { noopMetrics } from '../helpers/noop-metrics.js';
import { createProgrammablePlugin } from '../helpers/programmable-plugin.js';
import {
  findMessageReferences,
  purgeExternalDeliveryIndexes,
  purgeInitialQueue,
  purgeMessageReferences,
} from '../helpers/redis-references.js';
import { createWebhookRecorder, type WebhookRecorder } from '../helpers/webhook-recorder.js';
import { waitForDeliveryStatus, waitForMessageGone } from '../helpers/wait-for.js';

const shouldRun = process.env.RUN_REDIS_SMOKE === '1';
const baseDelivery = deviceMessagingConfigSchema.parse({ $schemaVersion: '1' }).delivery;

const PUSH_PLUGIN_ID = 'smoke-cleanup-push';
const PULL_PLUGIN_ID = 'smoke-cleanup-pull';
const NETWORK_ID = 503;
const RELAY_NODE_ID = 21;
const AWAITING_TASK_KEY = redisKeys.queueAwaitingTask(PULL_PLUGIN_ID);
/** Past the hardcoded 48h PULL ceiling (`PULL_MAX_MESSAGE_AGE_MS`). */
const AGED_MESSAGE_OFFSET_MS = 49 * 60 * 60 * 1000;

const PUSH_DEVICE: DeviceMessageDevice = {
  type: 'ELECTRICITY_METER',
  externalReference: 'smoke-cleanup-meter',
};
const PULL_DEVICE: DeviceMessageDevice = {
  ...PUSH_DEVICE,
  relayNode: { id: RELAY_NODE_ID },
};

const PUSH_QUEUE_KEY = createProgrammablePlugin({
  id: PUSH_PLUGIN_ID,
  deliveryPattern: 'PUSH',
}).initialQueueKey({ networkId: NETWORK_ID, device: PUSH_DEVICE });
const PULL_QUEUE_KEY = createProgrammablePlugin({
  id: PULL_PLUGIN_ID,
  deliveryPattern: 'PULL',
}).initialQueueKey({ networkId: null, device: PULL_DEVICE });

type PushHarness = {
  readonly outgoing: OutgoingService;
  readonly runner: LifecycleRunner;
  readonly recorder: WebhookRecorder;
};

function createPushHarness(options: {
  readonly sendOne?: (message: DeviceMessage) => Promise<string>;
  readonly maxRetries?: number;
} = {}): PushHarness {
  const delivery = {
    ...baseDelivery,
    ...(options.maxRetries !== undefined && { maxRetries: options.maxRetries }),
  };
  const { registry } = createProgrammablePlugin({
    id: PUSH_PLUGIN_ID,
    deliveryPattern: 'PUSH',
    sendOne: options.sendOne,
  });
  const recorder = createWebhookRecorder();
  const { outgoing, runner } = createEngineHarness({
    registry,
    delivery,
    webhook: recorder.webhook,
  });

  return { recorder, outgoing, runner };
}

type PullHarness = {
  readonly outgoing: OutgoingService;
  readonly runner: LifecycleRunner;
  readonly recorder: WebhookRecorder;
};

function createPullHarness(): PullHarness {
  const delivery = baseDelivery;
  const { registry } = createProgrammablePlugin({
    id: PULL_PLUGIN_ID,
    deliveryPattern: 'PULL',
  });
  const recorder = createWebhookRecorder();
  const { outgoing, runner } = createEngineHarness({
    registry,
    delivery,
    webhook: recorder.webhook,
  });

  return {
    recorder,
    outgoing,
    runner,
  };
}

const trash: Array<{ readonly id: string; readonly correlationId?: string }> = [];

async function enqueuePushTracked(
  outgoing: OutgoingService,
  correlationId: string,
): Promise<DeviceMessage> {
  const message = await outgoing.enqueue({
    commandType: 'READ_CREDIT',
    priority: 1,
    pluginId: PUSH_PLUGIN_ID,
    networkId: NETWORK_ID,
    correlationId,
    device: PUSH_DEVICE,
  });
  trash.push({ id: message.id, correlationId });
  return message;
}

/** A queue member whose message hash never existed. */
function trackedOrphanId(): string {
  const orphanId = ulid();
  trash.push({ id: orphanId });
  return orphanId;
}

describe.skipIf(!shouldRun)('lifecycle orphans and cleanup', () => {
  afterEach(async () => {
    for (const { id, correlationId } of trash) {
      await purgeMessageReferences(id, { correlationId });
    }
    trash.length = 0;
    await purgeInitialQueue(PUSH_QUEUE_KEY);
    await purgeInitialQueue(PULL_QUEUE_KEY);
    await purgeExternalDeliveryIndexes('ext-');
  });

  afterAll(async () => {
    await redis.quit();
  });

  describe('orphan scrubbing', () => {
    it.each([
      { stage: 'NS', queueKey: QUEUE_NS_KEY },
      { stage: 'relay-node', queueKey: STAGES.relayNode.key() },
      { stage: 'device', queueKey: STAGES.device.key() },
      { stage: 'retry', queueKey: QUEUE_RETRY_KEY },
    ])('scrubs an orphan from the $stage queue', async ({ queueKey }) => {
      const { runner } = createPushHarness();
      const orphanId = trackedOrphanId();
      await redis.zadd(queueKey, Date.now() - 1, orphanId);

      await runner.tick();

      expect(await redis.zscore(queueKey, orphanId)).toBeNull();
    });

    it('scrubs an orphan from the awaiting-task queue (A1)', async () => {
      // The stage the poll loop used to skip: a missing hash left the member in place at
      // an unchanged score, so the vendor was asked about a message that no longer
      // existed, on every tick, forever. The runner scrubs every stage the same way.
      const { runner } = createPullHarness();
      const orphanId = trackedOrphanId();
      await redis.zadd(AWAITING_TASK_KEY, Date.now() - 1, orphanId);

      await runner.tick();

      expect(await redis.zscore(AWAITING_TASK_KEY, orphanId)).toBeNull();
    });
  });

  describe('cleanup completeness', () => {
    it('leaves nothing behind when a message fails permanently', async () => {
      const { outgoing, recorder } = createPushHarness({
        maxRetries: 0,
        sendOne: async () => {
          throw new Error('unrecoverable');
        },
      });
      const correlationId = `cleanup-failed-${ Date.now() }`;
      const enqueued = await enqueuePushTracked(outgoing, correlationId);

      await outgoing.distributeToNetworkServers();
      await waitForMessageGone(outgoing, correlationId);

      expect(recorder.withStatus('DELIVERY_FAILED')).toHaveLength(1);
      expect(await findMessageReferences(enqueued.id, { correlationId })).toEqual([]);
    });

    it('leaves nothing behind when a queued message is cancelled', async () => {
      const { outgoing } = createPushHarness();
      const correlationId = `cleanup-cancel-queued-${ Date.now() }`;
      const enqueued = await enqueuePushTracked(outgoing, correlationId);

      expect(await outgoing.cancelOne(correlationId)).toMatchObject({ result: 'CANCELLED' });
      expect(await findMessageReferences(enqueued.id, { correlationId })).toEqual([]);
    });

    it('leaves nothing behind when a retrying message is cancelled', async () => {
      const { outgoing } = createPushHarness({
        maxRetries: 5,
        sendOne: async () => {
          throw new Error('will retry');
        },
      });
      const correlationId = `cleanup-cancel-retry-${ Date.now() }`;
      const enqueued = await enqueuePushTracked(outgoing, correlationId);

      await outgoing.distributeToNetworkServers();
      await waitForDeliveryStatus(outgoing, correlationId, [ 'TO_RETRY' ]);

      expect(await outgoing.cancelOne(correlationId)).toMatchObject({ result: 'CANCELLED' });
      expect(await findMessageReferences(enqueued.id, { correlationId })).toEqual([]);
    });

    it('leaves nothing behind when a PULL message exceeds its maximum age', async () => {
      const { runner, recorder } = createPullHarness();
      const correlationId = `cleanup-pull-aged-${ Date.now() }`;
      const agedId = ulid(Date.now() - AGED_MESSAGE_OFFSET_MS);
      trash.push({ id: agedId, correlationId });

      await redis.hset(redisKeys.message(agedId), {
        commandType: 'READ_CREDIT',
        priority: 1,
        pluginId: PULL_PLUGIN_ID,
        device: JSON.stringify(PULL_DEVICE),
        correlationId,
        deliveryStatus: 'DELIVERED_TO_NS',
        deliveryQueueId: 'ext-aged',
      });
      await redis.set(
        redisKeys.indexCorrelationId(correlationId),
        redisKeys.message(agedId),
      );
      // Due, because the age cap is now a property of the awaiting-task stage rather than
      // a separate full-queue scan (ADR-008 §9): an aged message is caught on its next
      // poll, which the ladder puts at most 30s out against a two-day cap.
      await redis.zadd(AWAITING_TASK_KEY, Date.now() - 1, agedId);

      await runner.tick();

      const failures = recorder.withStatus('DELIVERY_FAILED');
      expect(failures).toHaveLength(1);
      expect(failures[0]?.failureHistory?.[0]).toMatchObject({
        reason: 'Timed out waiting for remote task completion',
        isFinal: true,
      });
      expect(
        await findMessageReferences(agedId, { correlationId, deliveryQueueId: 'ext-aged' }),
      ).toEqual([]);
    });

    it('clears the ready and retry queues too (A4)', async () => {
      // A4 was a hand-written sweep list that omitted the retry queue and the ready queue,
      // leaving permanent orphans there. `purge` derives the list from the stage table plus
      // the plugin's ready queue, so both go — even with the message in two queues at once,
      // which no production path produces but which pins the derivation.
      const { outgoing } = createPushHarness();
      const { plugin } = createProgrammablePlugin({
        id: PUSH_PLUGIN_ID,
        deliveryPattern: 'PUSH',
      });
      const moves = createStageMoves({
        delivery: baseDelivery,
        metrics: noopMetrics,
        stageStore: createStageStore({ client: redis }),
      });
      const correlationId = `cleanup-partial-${ Date.now() }`;
      const enqueued = await enqueuePushTracked(outgoing, correlationId);
      await redis.zadd(QUEUE_RETRY_KEY, Date.now() + 60_000, enqueued.id);

      await moves.purge({ message: enqueued, plugin });

      expect(await findMessageReferences(enqueued.id, { correlationId })).toEqual([]);
    });
  });
});
