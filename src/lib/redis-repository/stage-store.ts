/**
 * @fileoverview Redis port for stage queues (plan 002 C1).
 *
 * Lua moves, expiry scans, requeue, cleanup, and the sorted-set primitives
 * `enterRetry` / `reschedule` need. Callers are `lifecycle/moves.ts` and
 * `lifecycle/runner.ts` — nothing else.
 */

import type { Redis } from 'iovalkey';

import type {
  DeviceMessage,
  DeviceMessageDeliveryStatus,
} from '../device-message/types.js';
import { assertExecSucceeded } from './assert-exec.js';
import { redisKeys } from './keys.js';
import type { FetchNextMessageResult } from './lua/fetch-next-message-in-queue.types.js';
import type { MoveMessageResult } from './lua/move-message-between-queues.types.js';

/**
 * Max members returned per timeout scan (`ZRANGEBYSCORE … LIMIT`).
 * Caps work per engine tick; leftover due members wait for the next tick.
 * Inherited from legacy — pragmatic batch size, not a measured optimum.
 */
const QUEUE_SCAN_BATCH_SIZE = 50;

/** Redis operations for stage queues. This port carries Redis vocabulary on purpose. */
export type StageStore = {
  moveMessageBetweenQueues(
    sourceQueue: string,
    destinationQueue: string,
    messageKey: string,
    indexKey: string,
    messageId: string,
    destinationScore: number | string,
    deliveryStatus: DeviceMessageDeliveryStatus,
    deliveryQueueId: string,
    indexTtlSeconds: number | string,
  ): Promise<MoveMessageResult>;
  fetchNextMessageInQueueAndMove(
    sourceQueue: string,
    destinationQueue: string,
    queuesToDistributeFrom: string,
    timeoutAt: number | string,
    newStatus: DeviceMessageDeliveryStatus,
  ): Promise<FetchNextMessageResult>;
  /**
   * Find members whose score is at or below `cutoffDate`.
   *
   * @param queueKey - Queue to scan
   * @param cutoffDate - Unix timestamp
   */
  getExpiredMessagesInQueue(queueKey: string, cutoffDate: number): Promise<string[]>;
  /**
   * ZREM one member. Cancel uses the return as an atomic claim.
   *
   * @param queueKey - Queue to remove from
   * @param messageId - Message ULID
   * @returns Number of members removed (0 or 1)
   */
  removeMessageFromQueue(queueKey: string, messageId: string): Promise<number>;
  /**
   * Move a message from retry back to an initial queue at its original priority.
   * Lua-gated: ZADD / HSET only if the member is still in `fromQueueKey` and the
   * hash still exists. `SADD` of the distribute set runs only after a committed move.
   *
   * @param messageId - ULID of the message
   * @param fromQueueKey - Source queue (typically retry)
   * @param toQueueKey - Destination initial queue
   * @param priority - Original priority (score `-priority`)
   * @returns `true` when the move committed, `false` when the source claim missed
   */
  requeueMessage(
    messageId: string,
    fromQueueKey: string,
    toQueueKey: string,
    priority: number,
  ): Promise<boolean>;
  /**
   * Delete a message and every reference to it, in one MULTI.
   *
   * Which queues those are is not decided here: the caller passes them.
   * `StageMoves.purge` is the one place that derives the list.
   *
   * @param message - Indexes and admission slot come from it
   * @param queueKeys - Every queue that could hold this message as a member
   */
  messageFullCleanup(
    message: DeviceMessage,
    queueKeys: readonly string[],
  ): Promise<void>;
  /** Initial queues the distributor should consider. */
  fetchQueuesWithMessages(): Promise<string[]>;
  zscore(key: string, member: string): Promise<string | null>;
  hmget(key: string, ...fields: string[]): Promise<(string | null)[]>;
  /**
   * Update a member's score only if it is still in the set (`ZADD XX`).
   *
   * @param key - Sorted set
   * @param score - New score
   * @param member - Message ULID
   */
  zaddXx(key: string, score: number, member: string): Promise<number>;
  /** MULTI for `enterRetry`'s compound write. */
  multi(): ReturnType<Redis['multi']>;
};

/** Dependencies for {@link createStageStore}. */
export type CreateStageStoreOptions = {
  readonly client: Redis;
};

/**
 * Factory for stage-queue Redis access (injected client).
 *
 * @param options - Redis client (Lua commands already registered)
 */
export function createStageStore(options: CreateStageStoreOptions): StageStore {
  const { client } = options;

  return {
    moveMessageBetweenQueues(
      sourceQueue,
      destinationQueue,
      messageKey,
      indexKey,
      messageId,
      destinationScore,
      deliveryStatus,
      deliveryQueueId,
      indexTtlSeconds,
    ) {
      return client.moveMessageBetweenQueues(
        sourceQueue,
        destinationQueue,
        messageKey,
        indexKey,
        messageId,
        destinationScore,
        deliveryStatus,
        deliveryQueueId,
        indexTtlSeconds,
      );
    },

    fetchNextMessageInQueueAndMove(
      sourceQueue,
      destinationQueue,
      queuesToDistributeFrom,
      timeoutAt,
      newStatus,
    ) {
      return client.fetchNextMessageInQueueAndMove(
        sourceQueue,
        destinationQueue,
        queuesToDistributeFrom,
        timeoutAt,
        newStatus,
      );
    },

    getExpiredMessagesInQueue(queueKey, cutoffDate) {
      return client.zrangebyscore(
        queueKey,
        '-inf',
        cutoffDate,
        'LIMIT',
        0,
        QUEUE_SCAN_BATCH_SIZE,
      );
    },

    removeMessageFromQueue(queueKey, messageId) {
      return client.zrem(queueKey, messageId);
    },

    async requeueMessage(messageId, fromQueueKey, toQueueKey, priority) {
      const moved = await client.moveMessageBetweenQueues(
        fromQueueKey,
        toQueueKey,
        redisKeys.message(messageId),
        '',
        messageId,
        -1 * priority,
        'QUEUED',
        '',
        0,
      );
      if (moved === 1) {
        await client.sadd(redisKeys.listOfInitialQueuesToDistributeFrom(), toQueueKey);
      }
      return moved === 1;
    },

    async messageFullCleanup(message, queueKeys) {
      const messageKey = redisKeys.message(message.id);

      const indexesToDelete = [
        message.correlationId && redisKeys.indexCorrelationId(message.correlationId, message.phase),
        message.deliveryQueueId && redisKeys.indexExternalDeliveryId(message.deliveryQueueId),
      ].filter(Boolean) as string[];

      const multi = client.multi();

      multi.del(messageKey);

      for (const queueKey of queueKeys) {
        multi.zrem(queueKey, message.id);
      }

      if (message.concurrencyRateLimitKey) {
        multi.srem(message.concurrencyRateLimitKey, message.id);
      }

      for (const indexKey of indexesToDelete) {
        multi.del(indexKey);
      }

      assertExecSucceeded(await multi.exec(), 'messageFullCleanup');
    },

    fetchQueuesWithMessages() {
      return client.smembers(redisKeys.listOfInitialQueuesToDistributeFrom());
    },

    zscore(key, member) {
      return client.zscore(key, member);
    },

    hmget(key, ...fields) {
      return client.hmget(key, ...fields);
    },

    zaddXx(key, score, member) {
      return client.zadd(key, 'XX', score, member);
    },

    multi() {
      return client.multi();
    },
  };
}
