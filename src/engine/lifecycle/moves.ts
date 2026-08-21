/**
 * @fileoverview Stage transitions — the only code that moves a message between queues.
 *
 * Every destination score, status and key comes from the stage table (ADR-008 §6). There
 * is one `advance`, so "what comes next" is decided in a single place: two call sites
 * deciding it independently is the shape of A3, where a post-send move raced the
 * `ns` deadline and the failure was discarded.
 *
 * All moves are ZREM-gated in Lua: the move proceeds only if the message is still in the
 * source queue and its hash still exists. That gate is what makes a re-run safe, and it is
 * why `advance` can report a lost claim rather than creating a phantom hash.
 */

import type { DeliveryConfig } from '../../config/schema.js';
import type {
  DeviceMessage,
  DeviceMessageDeliveryStatus,
  FailureReason,
} from '../../lib/device-message/types.js';
import { deserializeMessage, rawHashToObject } from '../../lib/redis-repository/helpers.js';
import { redisKeys } from '../../lib/redis-repository/keys.js';
import type { StageStore } from '../../lib/redis-repository/stage-store.js';
import { logger } from '../../log.js';
import type { MetricsRecorder } from '../../metrics/index.js';
import type { DeliveryPlugin } from '../../plugins/plugin.interface.js';
import {
  STAGES,
  enumerateStageKeys,
  nextStage,
  rescheduleWaitMsFor,
  stageKeyFor,
} from './stages.js';
import type { StageDefinition, StageName } from './types.js';

/** Stage transitions bound to the shared delivery knobs. */
export type StageMoves = {
  /**
   * Claim the highest-priority message from a ready queue into the `ns` stage.
   * Atomic in Lua so concurrent distribute passes cannot pick the same message.
   */
  pickIntoNs(readyQueueKey: string, plugin: DeliveryPlugin): Promise<DeviceMessage | undefined>;
  /**
   * Move a message to the next stage of its plugin's pipeline.
   * @returns `false` when the claim missed — the message was no longer in `from`,
   * so something else (usually the tick) already took ownership of it.
   */
  advance(args: AdvanceArgs): Promise<boolean>;
  /** Move a failed message from wherever it is into the retry stage. */
  enterRetry(args: EnterRetryArgs): Promise<void>;
  /** Extend the wait of a member still sitting in its stage. */
  reschedule(args: RescheduleArgs): Promise<void>;
  /** The terminal move: out of every queue and index the message could be in. */
  purge(args: PurgeArgs): Promise<void>;
  /** Initial queues the distributor should consider. */
  listReadyQueues(): Promise<string[]>;
  /**
   * ZREM as an atomic claim. Cancel uses this before {@link StageMoves.purge}:
   * a 0 means the distributor or tick already took the member.
   */
  claimFromQueue(queueKey: string, messageId: string): Promise<boolean>;
  /** Backoff elapsed: retry queue → the plugin's ready queue at original priority. */
  requeue(args: RequeueArgs): Promise<void>;
};

/** Arguments for {@link StageMoves.advance}. */
export type AdvanceArgs = {
  readonly messageId: string;
  readonly plugin: DeliveryPlugin;
  /** Stage the message is leaving. */
  readonly from: StageName;
  /** External reference from the network server; creates the delivery-id index. */
  readonly deliveryQueueId?: string;
  /** Only read when the destination's wait depends on it. */
  readonly retryCount?: number;
};

/** Arguments for {@link StageMoves.enterRetry}. */
export type EnterRetryArgs = {
  readonly messageId: string;
  /** Queue the message currently sits in. */
  readonly fromKey: string;
  /** Attempts *before* this failure — both the backoff input and the stored count minus one. */
  readonly currentRetryCount: number;
  readonly failureHistory: readonly FailureReason[];
  readonly plugin: DeliveryPlugin;
};

/** Arguments for {@link StageMoves.purge}. */
export type PurgeArgs = {
  readonly message: DeviceMessage;
  /** Owning plugin — the ready queue's key can only be built from it. */
  readonly plugin: DeliveryPlugin;
};

/** Arguments for {@link StageMoves.reschedule}. */
export type RescheduleArgs = {
  readonly stage: StageDefinition;
  readonly message: DeviceMessage;
  /** Age from the ULID; the row decides whether it matters. */
  readonly messageAgeMs: number;
  readonly plugin: DeliveryPlugin;
};

/** Arguments for {@link StageMoves.requeue}. */
export type RequeueArgs = {
  readonly messageId: string;
  readonly fromKey: string;
  readonly toKey: string;
  readonly priority: number;
};

/** Dependencies for {@link createStageMoves}. */
export type CreateStageMovesOptions = {
  readonly delivery: DeliveryConfig;
  readonly metrics: MetricsRecorder;
  readonly stageStore: StageStore;
};

/**
 * Factory for stage transitions.
 *
 * @param options - Shared delivery knobs, recorder, and the stage Redis port
 */
export function createStageMoves(options: CreateStageMovesOptions): StageMoves {
  const { delivery, metrics, stageStore } = options;

  /**
   * Move between two queues under the Lua ZREM gate.
   *
   * @returns true when the move committed, false when the source claim missed
   */
  async function _move(args: {
    messageId: string;
    fromKey: string;
    toKey: string;
    dueAt: number;
    deliveryStatus: DeviceMessageDeliveryStatus;
    deliveryQueueId?: string;
    indexKey?: string;
  }): Promise<boolean> {
    const result = await stageStore.moveMessageBetweenQueues(
      args.fromKey,
      args.toKey,
      redisKeys.message(args.messageId),
      args.indexKey ?? '',
      args.messageId,
      args.dueAt,
      args.deliveryStatus,
      args.deliveryQueueId ?? '',
      delivery.messageTtlSeconds,
    );

    return result === 1;
  }

  return {
    async pickIntoNs(
      readyQueueKey: string,
      plugin: DeliveryPlugin,
    ): Promise<DeviceMessage | undefined> {
      const dueAt = Date.now() + STAGES.ns.entryWaitMs({
        tuning: plugin.tuning,
        delivery,
        retryCount: 0,
      });

      const raw = await stageStore.fetchNextMessageInQueueAndMove(
        readyQueueKey,
        STAGES.ns.key(),
        redisKeys.listOfInitialQueuesToDistributeFrom(),
        dueAt,
        STAGES.ns.entryStatus,
      );

      if (!raw) return undefined;

      const [ id, rawHash ] = raw;
      return deserializeMessage(id, rawHashToObject(rawHash));
    },

    async advance({
      messageId,
      plugin,
      from,
      deliveryQueueId,
      retryCount = 0,
    }: AdvanceArgs): Promise<boolean> {
      const next = nextStage(plugin.deliveryPattern, from);
      if (!next) {
        throw new Error(
          `No stage after "${ from }" on the ${ plugin.deliveryPattern } pipeline`,
        );
      }

      const target = STAGES[next];
      const dueAt = Date.now() + target.entryWaitMs({
        tuning: plugin.tuning,
        delivery,
        retryCount,
      });

      const claimed = await _move({
        messageId,
        fromKey: stageKeyFor(STAGES[from], plugin.id),
        toKey: stageKeyFor(target, plugin.id),
        dueAt,
        deliveryStatus: target.entryStatus,
        deliveryQueueId,
        // A new external reference is the only reason to (re)create the index.
        indexKey: deliveryQueueId
          ? redisKeys.indexExternalDeliveryId(deliveryQueueId)
          : undefined,
      });

      // A3 used to end here silently: the caller discarded this boolean, so a send whose
      // move lost the race left no trace at all. Counted, not thrown — losing the claim is
      // legitimate (cancel, or a deadline that fired first), it is the rate that matters.
      if (!claimed) {
        metrics.recordStageClaimMiss(from);
        logger.warn(
          { module: 'lifecycle', messageId, from, to: next, pluginId: plugin.id },
          'stage advance lost the claim; another writer already moved this message',
        );
      }

      return claimed;
    },

    /**
     * Not a Lua move: entering retry also clears the stale external reference, releases
     * the admission slot, and rewrites retry metadata. The ZSCORE guard plays the role
     * the Lua gate plays elsewhere — it stops a double-retry when the tick and a failing
     * send race on the same message.
     */
    async enterRetry({
      messageId,
      fromKey,
      currentRetryCount,
      failureHistory,
      plugin,
    }: EnterRetryArgs): Promise<void> {
      const inQueue = await stageStore.zscore(fromKey, messageId);
      if (inQueue === null) return;

      const messageKey = redisKeys.message(messageId);
      const dueAt = Date.now() + STAGES.retry.entryWaitMs({
        tuning: plugin.tuning,
        delivery,
        retryCount: currentRetryCount,
      });

      const [ staleDeliveryQueueId, concurrencyRateLimitKey ] = await stageStore.hmget(
        messageKey,
        'deliveryQueueId',
        'concurrencyRateLimitKey',
      );

      const pipeline = stageStore.multi();

      pipeline.hset(messageKey, {
        retryCount: currentRetryCount + 1,
        deliveryStatus: STAGES.retry.entryStatus,
        failureHistory: JSON.stringify(failureHistory),
      });
      // @RACE-CONDITION :: Deleting this while a poll has already selected the message
      // leaves that poll checking an `undefined` deliveryQueueId.
      pipeline.hdel(messageKey, 'deliveryQueueId');

      pipeline.zrem(fromKey, messageId);
      pipeline.zadd(STAGES.retry.key(), dueAt, messageId);

      if (staleDeliveryQueueId) {
        pipeline.del(redisKeys.indexExternalDeliveryId(staleDeliveryQueueId));
      }

      if (concurrencyRateLimitKey) {
        pipeline.srem(concurrencyRateLimitKey, messageId);
        pipeline.hdel(messageKey, 'concurrencyRateLimitKey');
      }

      await pipeline.exec();
    },

    /**
     * `XX` so a member that left the stage between the read and this write is not
     * resurrected — e.g. an ingress event that advanced it while we were asking the
     * vendor for status.
     */
    async reschedule({ stage, message, messageAgeMs, plugin }: RescheduleArgs): Promise<void> {
      const waitMs = rescheduleWaitMsFor(stage, {
        message,
        messageAgeMs,
        tuning: plugin.tuning,
        delivery,
      });

      await stageStore.zaddXx(
        stageKeyFor(stage, plugin.id),
        Date.now() + waitMs,
        message.id,
      );
    },

    /**
     * Every queue a message could be a member of: its plugin's five stages plus the ready
     * queue it entered from. Derived, never listed — a message reaches a terminal state
     * from any of them, and the two that a hand-written list forgot (retry and the ready
     * queue) are exactly the ones cancel had to sweep by hand beforehand.
     */
    async purge({ message, plugin }: PurgeArgs): Promise<void> {
      const readyQueueKey = plugin.initialQueueKey({
        networkId: message.networkId,
        device: message.device,
      });

      await stageStore.messageFullCleanup(message, [
        ...enumerateStageKeys([ message.pluginId ]),
        readyQueueKey,
      ]);
    },

    listReadyQueues() {
      return stageStore.fetchQueuesWithMessages();
    },

    async claimFromQueue(queueKey, messageId) {
      const removed = await stageStore.removeMessageFromQueue(queueKey, messageId);
      return removed !== 0;
    },

    requeue({ messageId, fromKey, toKey, priority }) {
      return stageStore.requeueMessage(messageId, fromKey, toKey, priority);
    },
  };
}
