import { describe, expect, it } from 'vitest';

import type { DeliveryConfig } from '#src/config/schema.js';
import {
  STAGES,
  enumerateStageKeys,
  enumerateStageQueues,
  nextStage,
  rescheduleWaitMsFor,
  stageForStatus,
} from '#src/engine/lifecycle/stages.js';
import type { DeviceMessage } from '#src/lib/device-message/types.js';
import type { PluginTuning } from '#src/plugins/plugin.interface.js';

const CORE_KEYS = [
  'queue_in_flight_to_ns',
  'queue_in_flight_to_relay_node',
  'queue_in_flight_to_device',
  'queue_awaiting_retry',
];

const TUNING: PluginTuning = {
  nsInFlightTimeoutMs: 11_000,
  relayNodeInFlightTimeoutMs: 22_000,
  deviceInFlightTimeoutMs: 33_000,
  initialPollDelayMs: 44_000,
};

const DELIVERY: DeliveryConfig = {
  maxRetries: 11,
  retryBaseDelayMs: 2_000,
  retryBackoffMultiplier: 3,
  retryMaxDelayMs: 10_000_000,
  messageTtlSeconds: 604_800,
};

function message(retryCount?: number): DeviceMessage {
  return { retryCount } as DeviceMessage;
}

describe('STAGES', () => {
  it('pins Redis key, entryStatus, and isPerPlugin for each row', () => {
    expect(STAGES.ns.key()).toBe('queue_in_flight_to_ns');
    expect(STAGES.ns.entryStatus).toBe('SENT_TO_NS');
    expect(STAGES.ns.isPerPlugin).toBe(false);

    expect(STAGES.relayNode.key()).toBe('queue_in_flight_to_relay_node');
    expect(STAGES.relayNode.entryStatus).toBe('DELIVERED_TO_NS');
    expect(STAGES.relayNode.isPerPlugin).toBe(false);

    expect(STAGES.device.key()).toBe('queue_in_flight_to_device');
    expect(STAGES.device.entryStatus).toBe('SENT_TO_DEVICE');
    expect(STAGES.device.isPerPlugin).toBe(false);

    expect(STAGES.awaitingTask.key('calin-api-v1')).toBe(
      'queue_awaiting_task:calin-api-v1',
    );
    expect(STAGES.awaitingTask.entryStatus).toBe('DELIVERED_TO_NS');
    expect(STAGES.awaitingTask.isPerPlugin).toBe(true);

    expect(STAGES.retry.key()).toBe('queue_awaiting_retry');
    expect(STAGES.retry.entryStatus).toBe('TO_RETRY');
    expect(STAGES.retry.isPerPlugin).toBe(false);

    expect(
      Object.values(STAGES)
        .filter(stage => stage.isPerPlugin)
        .map(stage => stage.name),
    ).toEqual([ 'awaitingTask' ]);
  });

  it('computes entryWaitMs from the matching tuning field (retry uses backoff + jitter)', () => {
    const retryCount = 2;
    const context = { tuning: TUNING, delivery: DELIVERY, retryCount };

    expect(STAGES.ns.entryWaitMs(context)).toBe(TUNING.nsInFlightTimeoutMs);
    expect(STAGES.relayNode.entryWaitMs(context)).toBe(
      TUNING.relayNodeInFlightTimeoutMs,
    );
    expect(STAGES.device.entryWaitMs(context)).toBe(
      TUNING.deviceInFlightTimeoutMs,
    );
    expect(STAGES.awaitingTask.entryWaitMs(context)).toBe(
      TUNING.initialPollDelayMs,
    );

    const baseDelay =
      DELIVERY.retryBaseDelayMs
      * (DELIVERY.retryBackoffMultiplier ** retryCount);
    const retryWaitMs = STAGES.retry.entryWaitMs(context);
    expect(retryWaitMs).toBeGreaterThanOrEqual(baseDelay);
    expect(retryWaitMs).toBeLessThanOrEqual(1.5 * baseDelay);
  });
});

describe('STAGES.awaitingTask.rescheduleWaitMs', () => {
  const rescheduleWaitMs = STAGES.awaitingTask.rescheduleWaitMs;

  function waitForAge(messageAgeMs: number): number {
    return rescheduleWaitMs({
      message: message(),
      messageAgeMs,
      tuning: TUNING,
      delivery: DELIVERY,
    });
  }

  it('follows the age-based poll ladder', () => {
    expect(waitForAge(0)).toBe(10_000);
    expect(waitForAge(30_000)).toBe(15_000);
    expect(waitForAge(60_000)).toBe(20_000);
    expect(waitForAge(120_000)).toBe(30_000);
  });

  it('treats bucket boundaries as exclusive of the lower threshold', () => {
    expect(waitForAge(19_999)).toBe(10_000);
    expect(waitForAge(20_000)).toBe(15_000);
    expect(waitForAge(49_999)).toBe(15_000);
    expect(waitForAge(50_000)).toBe(20_000);
    expect(waitForAge(89_999)).toBe(20_000);
    expect(waitForAge(90_000)).toBe(30_000);
  });
});

describe('rescheduleWaitMsFor', () => {
  it('delegates to the poll ladder for awaitingTask', () => {
    const context = {
      message: message(),
      messageAgeMs: 30_000,
      tuning: TUNING,
      delivery: DELIVERY,
    };

    expect(rescheduleWaitMsFor(STAGES.awaitingTask, context)).toBe(
      STAGES.awaitingTask.rescheduleWaitMs(context),
    );
    expect(rescheduleWaitMsFor(STAGES.awaitingTask, context)).toBe(15_000);
  });

  it('falls back to entryWaitMs for rows without rescheduleWaitMs', () => {
    const context = {
      message: message(),
      messageAgeMs: 0,
      tuning: TUNING,
      delivery: DELIVERY,
    };

    expect(rescheduleWaitMsFor(STAGES.ns, context)).toBe(
      TUNING.nsInFlightTimeoutMs,
    );
    expect(rescheduleWaitMsFor(STAGES.relayNode, context)).toBe(
      TUNING.relayNodeInFlightTimeoutMs,
    );
  });

  it('passes message.retryCount through to retry backoff on fallback', () => {
    const waitAt = (retryCount: number): number => rescheduleWaitMsFor(
      STAGES.retry,
      {
        message: message(retryCount),
        messageAgeMs: 0,
        tuning: TUNING,
        delivery: DELIVERY,
      },
    );

    const wait0 = waitAt(0);
    const wait2 = waitAt(2);
    const base0 = DELIVERY.retryBaseDelayMs;
    const base2 =
      DELIVERY.retryBaseDelayMs
      * (DELIVERY.retryBackoffMultiplier ** 2);

    expect(wait0).toBeGreaterThanOrEqual(base0);
    expect(wait0).toBeLessThanOrEqual(1.5 * base0);
    expect(wait2).toBeGreaterThanOrEqual(base2);
    expect(wait2).toBeLessThanOrEqual(1.5 * base2);
    expect(wait2).toBeGreaterThan(wait0);
  });
});

describe('nextStage', () => {
  it('follows the PUSH pipeline ns → relayNode → device → end', () => {
    expect(nextStage('PUSH', 'ns')).toBe('relayNode');
    expect(nextStage('PUSH', 'relayNode')).toBe('device');
    expect(nextStage('PUSH', 'device')).toBeUndefined();
  });

  it('follows the PULL pipeline ns → awaitingTask → end', () => {
    expect(nextStage('PULL', 'ns')).toBe('awaitingTask');
    expect(nextStage('PULL', 'awaitingTask')).toBeUndefined();
    expect(nextStage('PULL', 'relayNode')).toBeUndefined();
  });

  it('returns undefined for retry on both patterns (off-pipeline; exit is the ready queue)', () => {
    expect(nextStage('PUSH', 'retry')).toBeUndefined();
    expect(nextStage('PULL', 'retry')).toBeUndefined();
  });
});

describe('stageForStatus', () => {
  it('maps SENT_TO_NS to ns on both patterns', () => {
    expect(stageForStatus('SENT_TO_NS', 'PUSH')).toBe('ns');
    expect(stageForStatus('SENT_TO_NS', 'PULL')).toBe('ns');
  });

  it('resolves DELIVERED_TO_NS by pattern', () => {
    // DELIVERED_TO_NS is PUSH relayNode or PULL awaitingTask. That ambiguity
    // is why no `stage` field is stored on the message hash — status + pattern
    // recover it.
    expect(stageForStatus('DELIVERED_TO_NS', 'PUSH')).toBe('relayNode');
    expect(stageForStatus('DELIVERED_TO_NS', 'PULL')).toBe('awaitingTask');
  });

  it('maps SENT_TO_DEVICE to device and TO_RETRY to retry', () => {
    expect(stageForStatus('SENT_TO_DEVICE', 'PUSH')).toBe('device');
    expect(stageForStatus('TO_RETRY', 'PUSH')).toBe('retry');
    expect(stageForStatus('TO_RETRY', 'PULL')).toBe('retry');
  });

  it('returns undefined for QUEUED and terminal statuses', () => {
    for (const pattern of [ 'PUSH', 'PULL' ] as const) {
      expect(stageForStatus('QUEUED', pattern)).toBeUndefined();
      expect(stageForStatus('DELIVERY_SUCCESSFUL', pattern)).toBeUndefined();
      expect(stageForStatus('DELIVERY_FAILED', pattern)).toBeUndefined();
    }
  });
});

describe('enumerateStageQueues / enumerateStageKeys', () => {
  it('returns only the four core keys when no plugin ids are given', () => {
    const queues = enumerateStageQueues([]);
    const keys = queues.map(queue => queue.key);

    expect(keys).toEqual(CORE_KEYS);
    expect(keys.some(key => key.startsWith('queue_awaiting_task:'))).toBe(false);
    for (const queue of queues) {
      expect(queue).not.toHaveProperty('pluginId');
    }
    expect(enumerateStageKeys([])).toEqual(keys);
  });

  it('expands one awaiting-task key per plugin id', () => {
    const pluginIds = [ 'calin-api-v1', 'calin-api-v2' ];
    const queues = enumerateStageQueues(pluginIds);
    const keys = queues.map(queue => queue.key);

    expect(keys).toEqual([
      'queue_in_flight_to_ns',
      'queue_in_flight_to_relay_node',
      'queue_in_flight_to_device',
      'queue_awaiting_task:calin-api-v1',
      'queue_awaiting_task:calin-api-v2',
      'queue_awaiting_retry',
    ]);
    expect(keys).toHaveLength(6);
    expect(new Set(keys).size).toBe(6);

    for (const queue of queues) {
      if (queue.stage.isPerPlugin) {
        expect(queue.pluginId).toBeDefined();
        expect(queue.key).toBe(`queue_awaiting_task:${ queue.pluginId }`);
      }
      else {
        expect(queue).not.toHaveProperty('pluginId');
      }
    }

    expect(enumerateStageKeys(pluginIds)).toEqual(keys);
    expect(enumerateStageKeys(pluginIds)).toEqual(
      enumerateStageQueues(pluginIds).map(queue => queue.key),
    );
  });
});
