/**
 * @fileoverview The message-lifecycle stage table (ADR-008) — data and pure lookups.
 *
 * Everything the engine knows about *where a message waits and for how long* lives here.
 * The runner loops over this table; cleanup and metrics derive their key lists from it.
 * There is deliberately no second list of queue names anywhere else in the codebase —
 * that duplication is how A4 and the metrics stage list drifted apart.
 *
 * Deliberately free of Redis and of the engine's peers: actions are injected
 * (`createStageActions`), so this module stays pure and unit-testable.
 *
 * Upgrade path — per-plugin pipelines ("Option B") — is designed in ADR-008
 * § *Upgrade path* and built only when its trigger fires.
 */

import { calculateBackoffDelay } from '../../lib/retry-helpers.js';
import { redisKeys } from '../../lib/redis-repository/keys.js';
import type {
  DeviceMessageDeliveryStatus,
  PluginId,
} from '../../lib/device-message/types.js';
import type {
  StageDefinition,
  StageName,
  StageQueue,
  StageRescheduleContext,
} from './types.js';

/** The `ns` stage key, needed by the send path before a message has advanced. */
export const QUEUE_NS_KEY = 'queue_in_flight_to_ns';

/** The retry stage key, needed by cancel (which claims from it directly). */
export const QUEUE_RETRY_KEY = 'queue_awaiting_retry';

/**
 * Default poll ladder: the older a message is, the less often it is polled.
 *
 * Core-owned. A plugin `tuning` override for the ladder is not in C4 — the ladder is a
 * function of age, not a single number. `rescheduleWaitMs` already receives `tuning` if
 * a later item adds a knob.
 *
 * @param messageAgeMs - Age of the message, from its ULID timestamp
 */
function defaultPollLadderMs(messageAgeMs: number): number {
  if (messageAgeMs < 20_000) return 10_000;
  if (messageAgeMs < 50_000) return 15_000;
  if (messageAgeMs < 90_000) return 20_000;
  return 30_000;
}

/**
 * How long a message may sit in `awaitingTask` before it fails permanently (48 hours).
 *
 * A property of that stage rather than a row field: it is the only stage that expires
 * outright instead of retrying, and enforcing it needs a terminal webhook and cleanup —
 * action work, not something the runner could do generically from a number (ADR-008 §9).
 */
export const PULL_MAX_MESSAGE_AGE_MS = 48 * 60 * 60 * 1000;

/**
 * The stage table. Rows, not files: PUSH and PULL differ only in which rows they visit
 * (see {@link PIPELINES}), what the score means, and who reports the outcome.
 *
 * Waits are durations. Whoever writes the score adds `now` — one place, so a stage cannot
 * be scheduled against a clock reading of its own.
 */
export const STAGES = {
  ns: {
    name: 'ns',
    key: () => QUEUE_NS_KEY,
    entryStatus: 'SENT_TO_NS',
    // Rescheduled (not failed) while this process still holds the send — ADR-008 §8.
    entryWaitMs: ({ tuning }) => tuning.nsInFlightTimeoutMs,
    isPerPlugin: false,
  },
  relayNode: {
    name: 'relayNode',
    key: () => 'queue_in_flight_to_relay_node',
    entryStatus: 'DELIVERED_TO_NS',
    // Rescheduled when the plugin reports the command is still queued remotely.
    entryWaitMs: ({ tuning }) => tuning.relayNodeInFlightTimeoutMs,
    isPerPlugin: false,
  },
  device: {
    name: 'device',
    key: () => 'queue_in_flight_to_device',
    entryStatus: 'SENT_TO_DEVICE',
    entryWaitMs: ({ tuning }) => tuning.deviceInFlightTimeoutMs,
    isPerPlugin: false,
  },
  awaitingTask: {
    name: 'awaitingTask',
    key: pluginId => redisKeys.queueAwaitingTask(pluginId),
    entryStatus: 'DELIVERED_TO_NS',
    // The only stage whose score is a next-poll time rather than a deadline, and so the
    // only one whose wait is dynamic.
    entryWaitMs: ({ tuning }) => tuning.initialPollDelayMs,
    rescheduleWaitMs: ({ messageAgeMs }) => defaultPollLadderMs(messageAgeMs),
    isPerPlugin: true,
  },
  retry: {
    name: 'retry',
    key: () => QUEUE_RETRY_KEY,
    entryStatus: 'TO_RETRY',
    // Never rescheduled: when due, it requeues to the ready queue.
    entryWaitMs: ({ delivery, retryCount }) => calculateBackoffDelay(retryCount, delivery),
    isPerPlugin: false,
  },
} as const satisfies Record<StageName, StageDefinition>;

/**
 * Ordered forward path per delivery pattern, as data rather than as branches — which is
 * what keeps Option B a one-line `??` rather than a rewrite (ADR-008 § *Invariants*).
 *
 * Keyed on `'PUSH' | 'PULL'`, not on `DeliveryPattern`: `'NONE'` (token-only) has no
 * pipeline because those plugins never enqueue.
 */
export const PIPELINES = {
  PUSH: [ 'ns', 'relayNode', 'device' ],
  PULL: [ 'ns', 'awaitingTask' ],
} as const satisfies Record<'PUSH' | 'PULL', readonly StageName[]>;

/** The delivery patterns that have a pipeline (excludes token-only `'NONE'`). */
export type PipelinePattern = keyof typeof PIPELINES;

/**
 * The stage a message would enter next on this pipeline, or `undefined` at the end of it.
 *
 * The end of a pipeline is not a failure: `device` and `awaitingTask` are resolved by an
 * incoming event or a poll, not by advancing. `retry` is off-pipeline and always returns
 * `undefined` — its exit is the ready queue, which is not a stage.
 *
 * @param pattern - Delivery pattern of the owning plugin
 * @param current - Stage the message is in now
 */
export function nextStage(
  pattern: PipelinePattern,
  current: StageName,
): StageName | undefined {
  const pipeline: readonly StageName[] = PIPELINES[pattern];
  const index = pipeline.indexOf(current);
  if (index === -1) return undefined;
  return pipeline[index + 1];
}

/**
 * The stage a message is currently waiting in, derived from its delivery status.
 *
 * Under the fixed pipelines of Option A this is unambiguous, which is why no `stage`
 * field is stored on the message hash and why the Redis layout is unchanged (ADR-008 §12).
 * `undefined` means the message is not in a stage: `QUEUED` is in the ready queue, and the
 * terminal statuses are in no queue at all.
 *
 * @param status - Delivery status from the message hash
 * @param pattern - Delivery pattern of the owning plugin
 */
export function stageForStatus(
  status: DeviceMessageDeliveryStatus,
  pattern: PipelinePattern,
): StageName | undefined {
  switch (status) {
    case 'SENT_TO_NS':
      return 'ns';
    case 'DELIVERED_TO_NS':
      return pattern === 'PUSH' ? 'relayNode' : 'awaitingTask';
    case 'SENT_TO_DEVICE':
      return 'device';
    case 'TO_RETRY':
      return 'retry';
    case 'QUEUED':
    case 'DELIVERY_SUCCESSFUL':
    case 'DELIVERY_FAILED':
      return undefined;
    default: {
      const unhandled: never = status;
      throw new Error(`unhandled delivery status: ${ unhandled }`);
    }
  }
}

/**
 * The Redis key of one stage for one plugin.
 *
 * The single place that resolves the two key shapes, so no caller has to ask whether a
 * stage is plugin-namespaced before it can name a queue.
 *
 * @param stage - The stage to build a key for
 * @param pluginId - Owning plugin; ignored by core stages
 */
export function stageKeyFor(stage: StageDefinition, pluginId: PluginId): string {
  return stage.isPerPlugin ? stage.key(pluginId) : stage.key();
}

/**
 * How long a member that is still waiting in this stage should wait again.
 *
 * The single home of the `rescheduleWaitMs ?? entryWaitMs` fallback, so the runner never
 * restates it and no caller can pick a wait the row did not sanction.
 *
 * @param stage - The stage the member is waiting in
 * @param context - Message, tick time, and the owning plugin's knobs
 */
export function rescheduleWaitMsFor(
  stage: StageDefinition,
  context: StageRescheduleContext,
): number {
  if (stage.rescheduleWaitMs) return stage.rescheduleWaitMs(context);

  return stage.entryWaitMs({
    tuning: context.tuning,
    delivery: context.delivery,
    retryCount: context.message.retryCount ?? 0,
  });
}

/**
 * Every stage queue that exists, given the plugins whose per-plugin stages should be
 * expanded. **The single source of stage keys** — the runner scans these, cleanup ZREMs
 * these, and metrics measures these.
 *
 * Pass every enabled PULL plugin id for a service-wide view (runner, metrics), or a single
 * id for one message's view (cleanup).
 *
 * @param pluginIds - Plugin ids whose per-plugin stage keys to include
 */
export function enumerateStageQueues(
  pluginIds: readonly PluginId[],
): StageQueue[] {
  const queues: StageQueue[] = [];
  const stages: readonly StageDefinition[] = Object.values(STAGES);

  for (const stage of stages) {
    if (!stage.isPerPlugin) {
      queues.push({ stage, key: stage.key() });
      continue;
    }
    for (const pluginId of pluginIds) {
      queues.push({ stage, key: stage.key(pluginId), pluginId });
    }
  }

  return queues;
}

/**
 * Stage keys only — the common case for callers that do not need the definitions.
 *
 * @param pluginIds - Plugin ids whose per-plugin stage keys to include
 */
export function enumerateStageKeys(pluginIds: readonly PluginId[]): string[] {
  return enumerateStageQueues(pluginIds).map(({ key }) => key);
}
