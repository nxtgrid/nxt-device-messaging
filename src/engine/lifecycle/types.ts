/**
 * @fileoverview Types for the message-lifecycle stage table (ADR-008).
 *
 * A **stage** is a Redis sorted set whose score is *the time the engine should next pay
 * attention to a member*. That is the whole idea: a timeout and a next-poll time are the
 * same concept with different actions attached (ADR-008 §3).
 *
 * The **ready queue** (`queue:{pluginId}:{kind}:{id}`, score `-priority`) is deliberately
 * not a stage — its score is spent on priority, so it cannot be scanned by due time. It is
 * the pipeline's entry point and belongs to admission (ADR-006).
 *
 * These types carry no behaviour: stage *actions* are injected at the composition root so
 * the table stays free of Redis and of the engine's peers.
 */

import type { DeliveryConfig } from '../../config/schema.js';
import type {
  DeviceMessage,
  DeviceMessageDeliveryStatus,
  PluginId,
} from '../../lib/device-message/types.js';
import type { DeliveryPlugin, PluginTuning } from '../../plugins/plugin.interface.js';

/**
 * The closed set of stages a message can wait in.
 *
 * `retry` is a stage but is not on any pipeline: it is reachable from every stage and its
 * exit is backwards, to the ready queue. Pipelines describe only the forward path.
 */
export type StageName =
  | 'ns'
  | 'relayNode'
  | 'device'
  | 'awaitingTask'
  | 'retry';

/**
 * Inputs available when a message **enters** a stage.
 *
 * No message here, deliberately: entering `ns` happens inside the pick-and-move Lua, which
 * chooses the highest-priority member itself, so the score has to be computed before the
 * message's identity is known.
 */
export type StageEntryContext = {
  /** Owning plugin's stage timeouts / initial poll delay. */
  readonly tuning: PluginTuning;
  /** Shared retry knobs; only the retry stage reads them. */
  readonly delivery: DeliveryConfig;
  /** Previous retry attempts; only the retry stage reads it. */
  readonly retryCount: number;
};

/**
 * Inputs available when the runner **reschedules** a member that is still waiting in a
 * stage. The message is always present: the runner loaded it before calling the action.
 */
export type StageRescheduleContext = {
  readonly message: DeviceMessage;
  /**
   * Age from the message's ULID timestamp, computed once by the runner.
   *
   * Passed in rather than derived here so no stage row holds a clock, and because the
   * `awaitingTask` action needs the same number for its max-age cap — one `decodeTime`
   * per due member, not one per reader.
   */
  readonly messageAgeMs: number;
  readonly tuning: PluginTuning;
  readonly delivery: DeliveryConfig;
};

/** Fields every stage has, whatever its key shape. */
type StageBase = {
  readonly name: StageName;
  /** Delivery status written to the message hash on entry. */
  readonly entryStatus: DeviceMessageDeliveryStatus;
  /**
   * How long to wait, in ms, when a message enters this stage. A duration, not an
   * instant — the one place that adds `now` is the helper writing the score.
   */
  readonly entryWaitMs: (context: StageEntryContext) => number;
  /**
   * How long to wait again when the member is still here. Defaults to
   * {@link StageBase.entryWaitMs}, which is right for every stage whose wait is fixed —
   * only a dynamic wait (the poll ladder) needs to override it.
   */
  readonly rescheduleWaitMs?: (context: StageRescheduleContext) => number;
};

/** A stage with one Redis key for the whole service. */
type CoreStage = StageBase & {
  readonly isPerPlugin: false;
  readonly key: () => string;
};

/** A stage with one Redis key per plugin, e.g. `queue_awaiting_task:{pluginId}`. */
type PerPluginStage = StageBase & {
  readonly isPerPlugin: true;
  readonly key: (pluginId: PluginId) => string;
};

/**
 * One row of the stage table: where a message waits, what it is called while it waits,
 * and how long the wait is.
 *
 * Discriminated on {@link StageBase} key shape so that "does this key need a plugin id?"
 * is asked once, by the type system, instead of being restated at each call site. Always
 * build keys through `key` — never by writing a queue name (see
 * {@link enumerateStageQueues}).
 */
export type StageDefinition = CoreStage | PerPluginStage;

/**
 * What an action did with a due member, and therefore what the runner still owes it.
 *
 * This is the mechanism behind A1 and A2 (ADR-008 §5): the runner — not the action —
 * scrubs orphans and advances scores, and an action that returns nothing is a type error.
 * A stage added later cannot forget either rule.
 *
 * Note there is no `dueAt` to hand back. An action reports *that* the message is still
 * waiting; the stage row decides *how long*. Polling a vendor too soon is therefore not
 * expressible in an action — which is the same class of mistake as A2, one layer up.
 *
 * - `rescheduled` — still waiting here; the runner writes a new score from the row.
 * - `movedOn` — the action moved it to another stage or queue; the runner does nothing.
 * - `removed` — terminal; the action cleaned up and the member is already gone.
 * - `orphaned` — the message hash vanished under us; the runner removes the member.
 */
export type StageOutcome =
  | 'rescheduled'
  | 'movedOn'
  | 'removed'
  | 'orphaned';

/**
 * A stage paired with one concrete Redis key. Per-plugin stages produce one of these per
 * plugin; core stages produce exactly one.
 */
export type StageQueue = {
  readonly stage: StageDefinition;
  readonly key: string;
  /** Set only for per-plugin stages. */
  readonly pluginId?: PluginId;
};

/**
 * One due member, as handed to a stage action.
 *
 * The runner has already loaded the message, resolved its plugin and computed its age, so
 * an action never re-reads what the loop just read. There is no `now`: an action decides
 * *what* happened, and the stage row decides *when* to look again.
 */
export type StageActionContext = {
  readonly stage: StageDefinition;
  /** The concrete queue the member sits in — per-plugin stages differ per plugin. */
  readonly queueKey: string;
  readonly message: DeviceMessage;
  readonly plugin: DeliveryPlugin;
  /** Age from the ULID timestamp, computed once per member by the runner. */
  readonly messageAgeMs: number;
};

/**
 * What to do with a member whose wait has run out.
 *
 * Actions perform the domain work (ask the vendor, retry, clean up) and report back; the
 * runner performs the ZADD and the ZREM. That division is what makes A1 and A2
 * unrepresentable rather than merely fixed (ADR-008 §5).
 */
export type StageAction = (context: StageActionContext) => Promise<StageOutcome>;

/** One action per stage — total, so a new row cannot ship without one. */
export type StageActions = Record<StageName, StageAction>;
