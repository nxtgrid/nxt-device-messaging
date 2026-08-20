/**
 * Failure ladder for outgoing sends: throw → retry → permanent failure, plus the
 * unrecoverable short-circuit. Pins the behaviour the stage-table refactor must keep.
 *
 * Opt-in (needs Valkey):
 *
 *   docker compose up -d valkey
 *   RUN_REDIS_SMOKE=1 pnpm exec vitest run test/integration/outgoing-retry-ladder.smoke.spec.ts
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { deviceMessagingConfigSchema } from '#src/config/schema.js';
import { createBaseService } from '#src/engine/base.js';
import { createOutgoingService, type OutgoingService } from '#src/engine/outgoing.js';
import type { DeviceMessage, DeviceMessageDevice } from '#src/lib/device-message/types.js';
import { QUEUE_NS_KEY, QUEUE_RETRY_KEY } from '#src/lib/queue-moving.js';
import { redisRepo } from '#src/lib/redis-repository/index.js';
import { sleep } from '#src/lib/utilities.js';
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

const PLUGIN_ID = 'smoke-retry-push';
const NETWORK_ID = 501;
/** Short enough that a retry becomes due inside the test, long enough to observe. */
const RETRY_BASE_DELAY_MS = 10;

const DEVICE: DeviceMessageDevice = {
  type: 'ELECTRICITY_METER',
  externalReference: 'smoke-retry-meter',
};

const QUEUE_KEY = createProgrammablePlugin({
  id: PLUGIN_ID,
  deliveryPattern: 'PUSH',
}).initialQueueKey({ networkId: NETWORK_ID, device: DEVICE });

type Harness = {
  readonly outgoing: OutgoingService;
  readonly recorder: WebhookRecorder;
};

function createHarness(options: {
  readonly sendOne: (message: DeviceMessage) => Promise<string>;
  readonly maxRetries: number;
}): Harness {
  const delivery = {
    ...baseDelivery,
    maxRetries: options.maxRetries,
    retryBaseDelayMs: RETRY_BASE_DELAY_MS,
  };
  const { registry } = createProgrammablePlugin({
    id: PLUGIN_ID,
    deliveryPattern: 'PUSH',
    sendOne: options.sendOne,
  });
  const recorder = createWebhookRecorder();
  const metrics = noopMetrics;

  const outgoing = createOutgoingService({
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
  });

  return {
    outgoing,
    recorder,
  };
}

/** Messages to purge after each test, whether it passed or threw mid-flight. */
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

describe.skipIf(!shouldRun)('outgoing failure ladder', () => {
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

  it('parks a thrown send in the retry queue and clears the NS stage', async () => {
    const { outgoing } = createHarness({
      maxRetries: 1,
      sendOne: async () => {
        throw new Error('vendor exploded');
      },
    });
    const correlationId = `retry-throw-${ Date.now() }`;
    const enqueued = await enqueueTracked(outgoing, correlationId);

    await outgoing.distributeToNetworkServers();
    const parked = await waitForDeliveryStatus(outgoing, correlationId, [ 'TO_RETRY' ]);

    expect(parked.retryCount).toBe(1);
    expect(parked.failureHistory?.[0]).toMatchObject({
      reason: 'vendor exploded',
      isFinal: false,
    });
    // The failed attempt must not be left holding a stage slot.
    expect(await redisRepo.client.zscore(QUEUE_NS_KEY, enqueued.id)).toBeNull();

    const retryScore = await redisRepo.client.zscore(QUEUE_RETRY_KEY, enqueued.id);
    expect(retryScore).not.toBeNull();
    // Backoff is base + up to 50% jitter, so only the order of magnitude is assertable.
    expect(Number(retryScore)).toBeGreaterThan(Date.now() - 1_000);
    expect(Number(retryScore)).toBeLessThan(Date.now() + 1_000);
  });

  it('fails permanently once the ladder is exhausted, leaving no Redis trace', async () => {
    const { outgoing, recorder } = createHarness({
      maxRetries: 1,
      sendOne: async () => {
        throw new Error('vendor still exploded');
      },
    });
    const correlationId = `retry-exhaust-${ Date.now() }`;
    const enqueued = await enqueueTracked(outgoing, correlationId);

    await outgoing.distributeToNetworkServers();
    await waitForDeliveryStatus(outgoing, correlationId, [ 'TO_RETRY' ]);

    // Let the backoff elapse, then run the cycle that requeues and re-sends.
    await sleep(RETRY_BASE_DELAY_MS * 4);
    await outgoing.runMessageResolutionCycle();
    await waitForMessageGone(outgoing, correlationId);

    const failures = recorder.withStatus('DELIVERY_FAILED');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.failureHistory?.[0]).toMatchObject({ isFinal: true });
    expect(failures[0]?.failureHistory).toHaveLength(2);

    expect(await findMessageReferences(enqueued.id, { correlationId })).toEqual([]);
  });

  it('treats an empty deliveryQueueId as unrecoverable and skips the ladder', async () => {
    const { outgoing, recorder } = createHarness({
      maxRetries: 5,
      sendOne: async () => '',
    });
    const correlationId = `retry-empty-id-${ Date.now() }`;
    const enqueued = await enqueueTracked(outgoing, correlationId);

    await outgoing.distributeToNetworkServers();
    await waitForMessageGone(outgoing, correlationId);

    // skipRetry means terminal on the first attempt, with retries still available.
    expect(await redisRepo.client.zscore(QUEUE_RETRY_KEY, enqueued.id)).toBeNull();

    const failures = recorder.withStatus('DELIVERY_FAILED');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.failureHistory?.[0]).toMatchObject({
      reason: 'Plugin returned an empty deliveryQueueId after sendOne',
      isFinal: true,
    });

    expect(await findMessageReferences(enqueued.id, { correlationId })).toEqual([]);
  });
});
