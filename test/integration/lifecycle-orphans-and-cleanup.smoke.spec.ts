/**
 * Two invariants the stage-table refactor must not regress:
 *
 * 1. **Orphan scrubbing** — a queue member whose hash is gone must not stay forever.
 * 2. **Cleanup completeness** — a message that ends leaves no Redis reference behind.
 *
 * Both are asserted against *today's* behaviour, gaps included, so the refactor's diff
 * shows exactly which assertions it fixes.
 *
 * Opt-in (needs Valkey):
 *
 *   docker compose up -d valkey
 *   RUN_REDIS_SMOKE=1 pnpm exec vitest run test/integration/lifecycle-orphans-and-cleanup.smoke.spec.ts
 */
import { ulid } from 'ulid';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { deviceMessagingConfigSchema } from '#src/config/schema.js';
import { createBaseService } from '#src/engine/base.js';
import { createIncomingService, type IncomingService } from '#src/engine/incoming.js';
import { QUEUE_NS_KEY, QUEUE_RETRY_KEY, STAGES } from '#src/engine/lifecycle/stages.js';
import { createOutgoingService, type OutgoingService } from '#src/engine/outgoing.js';
import type { DeviceMessage, DeviceMessageDevice } from '#src/lib/device-message/types.js';
import { redisKeys } from '#src/lib/redis-repository/keys.js';
import { redisRepo } from '#src/lib/redis-repository/index.js';
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
/** Past the hardcoded 48h PULL ceiling in `lifecycle.pull.ts`. */
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
  const metrics = noopMetrics;

  return {
    recorder,
    outgoing: createOutgoingService({
      registry,
      delivery,
      baseService: createBaseService({
        registry,
        delivery,
        webhook: recorder.webhook,
        metrics,
      }),
      metrics,
      kickDistributeOnEnqueue: false,
    }),
  };
}

type PullHarness = {
  readonly outgoing: OutgoingService;
  readonly incoming: IncomingService;
  readonly recorder: WebhookRecorder;
};

function createPullHarness(): PullHarness {
  const delivery = baseDelivery;
  const { registry } = createProgrammablePlugin({
    id: PULL_PLUGIN_ID,
    deliveryPattern: 'PULL',
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
    await redisRepo.client.quit();
  });

  describe('orphan scrubbing', () => {
    it.each([
      { stage: 'NS', queueKey: QUEUE_NS_KEY },
      { stage: 'relay-node', queueKey: STAGES.relayNode.key() },
      { stage: 'device', queueKey: STAGES.device.key() },
      { stage: 'retry', queueKey: QUEUE_RETRY_KEY },
    ])('scrubs an orphan from the $stage queue', async ({ queueKey }) => {
      const { outgoing } = createPushHarness();
      const orphanId = trackedOrphanId();
      await redisRepo.client.zadd(queueKey, Date.now() - 1, orphanId);

      await outgoing.runMessageResolutionCycle();

      expect(await redisRepo.client.zscore(queueKey, orphanId)).toBeNull();
    });

    it('never scrubs an orphan from the awaiting-task queue (A1/A2)', async () => {
      // A1: the poll loop `continue`s past a missing hash without removing the member.
      // A2: it also leaves the score untouched, so the orphan is re-read every tick
      // and the vendor is asked about it forever. The stage table must scrub here and
      // advance the score on every branch; this should then be null.
      const { incoming } = createPullHarness();
      const orphanId = trackedOrphanId();
      const dueAt = Date.now() - 1;
      await redisRepo.client.zadd(AWAITING_TASK_KEY, dueAt, orphanId);

      await incoming.pollPullPlugins();

      expect(await redisRepo.client.zscore(AWAITING_TASK_KEY, orphanId)).toBe(String(dueAt));
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
      const { outgoing, recorder } = createPullHarness();
      const correlationId = `cleanup-pull-aged-${ Date.now() }`;
      const agedId = ulid(Date.now() - AGED_MESSAGE_OFFSET_MS);
      trash.push({ id: agedId, correlationId });

      await redisRepo.client.hset(redisKeys.message(agedId), {
        commandType: 'READ_CREDIT',
        priority: 1,
        pluginId: PULL_PLUGIN_ID,
        device: JSON.stringify(PULL_DEVICE),
        correlationId,
        deliveryStatus: 'DELIVERED_TO_NS',
        deliveryQueueId: 'ext-aged',
      });
      await redisRepo.client.set(
        redisKeys.indexCorrelationId(correlationId),
        redisKeys.message(agedId),
      );
      // Not yet due for polling — the age reaper, not the poll loop, must claim it.
      await redisRepo.client.zadd(AWAITING_TASK_KEY, Date.now() + 60_000, agedId);

      await outgoing.runMessageResolutionCycle();

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

    it('cannot clear the initial or retry queue (A4)', async () => {
      // A4: `messageFullCleanup` only sweeps the fixed stage queues plus awaiting-task,
      // so membership of an initial queue or the retry queue survives it as a permanent
      // orphan. No production path reaches this today, which is why it is asserted at the
      // repository contract rather than through the engine. The stage table must derive
      // the sweep list from the table; this should then be [].
      const { outgoing } = createPushHarness();
      const correlationId = `cleanup-partial-${ Date.now() }`;
      const enqueued = await enqueuePushTracked(outgoing, correlationId);
      await redisRepo.client.zadd(QUEUE_RETRY_KEY, Date.now() + 60_000, enqueued.id);

      await redisRepo.messageFullCleanup(enqueued);

      expect(await findMessageReferences(enqueued.id, { correlationId })).toEqual([
        PUSH_QUEUE_KEY,
        QUEUE_RETRY_KEY,
      ]);
    });
  });
});
