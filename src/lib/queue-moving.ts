/**
 * @fileoverview Shared queue transition logic for the message delivery pipeline.
 *
 * Pattern-specific transitions are in:
 * - queue-moving.push.ts (PUSH / webhook pattern)
 * - queue-moving.pull.ts (PULL / polling pattern)
 *
 * This file contains shared primitives used by both patterns.
 */

import type { DeliveryConfig } from '../config/schema.js';
import { redisRepo } from './redis-repository/index.js';
import { deserializeMessage, rawHashToObject } from './redis-repository/helpers.js';
import { redisKeys } from './redis-repository/keys.js';
import type { DeviceMessageDeliveryStatus, FailureReason } from './device-message/types.js';


/**
 * Configuration for an in-flight queue stage.
 */
export type QueueConfig = {
  /** Redis key for this queue. */
  KEY: string;
  /** Delivery status to set when message enters this queue. */
  MESSAGE_STATUS: DeviceMessageDeliveryStatus;
};

/** Network Server queue: awaiting NS to accept the downlink request. */
const CONFIG_QUEUE_NS: QueueConfig = {
  KEY: 'queue_in_flight_to_ns',
  MESSAGE_STATUS: 'SENT_TO_NS',
};

/** Exported key for Network Server queue. */
export const QUEUE_NS_KEY = CONFIG_QUEUE_NS.KEY;

/** Queue for messages waiting to be retried after backoff period. */
export const QUEUE_RETRY_KEY = 'queue_awaiting_retry';

/**
 * Internal helper to move a message between queues atomically.
 * Exported for use by pattern-specific queue-moving modules.
 *
 * Uses a Lua script to prevent phantom hash creation: the move only proceeds
 * if the message is still present in the source queue (ZREM gate). This
 * eliminates the race where a late-arriving API response writes to a
 * message hash that was already cleaned up.
 *
 * @returns true if the move succeeded, false if the message was not in the source queue
 */
export const _moveQueue = async (
  messageId: string,
  fromQueue: string,
  toQueue: string,
  timesOutAt: number,
  updateProps: {
    deliveryStatus: DeviceMessageDeliveryStatus;
    deliveryQueueId?: string;
  },
  messageTtlSeconds: number,
  indexToCreate?: string,
): Promise<boolean> => {
  const messageKey = redisKeys.message(messageId);

  const result = await redisRepo.client.moveMessageBetweenQueues(
    fromQueue,
    toQueue,
    messageKey,
    indexToCreate ?? '',
    messageId,
    timesOutAt,
    updateProps.deliveryStatus,
    updateProps.deliveryQueueId ?? '',
    messageTtlSeconds,
  );

  return result === 1;
};

/**
 * Shared queue transition operations used by both PUSH and PULL patterns.
 */
export const moveQueue = {
  /**
   * Atomically pick the highest-priority message from an initial queue
   * and move it to the Network Server in-flight queue.
   *
   * Uses a Lua script for atomicity to prevent race conditions when
   * multiple workers are distributing messages.
   *
   * @param fromQueueKey - Initial queue to pick from (plugin `initialQueueKey`)
   * @returns The message if one was picked, undefined if queue was empty
   */
  async pickNextAndMoveToNs(fromQueueKey: string, deliveryConfig: DeliveryConfig) {
    const timesOutAt = Date.now() + deliveryConfig.nsInFlightTimeoutMs;
    const initialQueuesList = redisKeys.listOfInitialQueuesToDistributeFrom();

    const raw = await redisRepo.client.fetchNextMessageInQueueAndMove(
      fromQueueKey,
      CONFIG_QUEUE_NS.KEY,
      initialQueuesList,
      timesOutAt,
      CONFIG_QUEUE_NS.MESSAGE_STATUS,
    );

    if (!raw) return;
    const [ id, rawHash ] = raw;
    const rawObject = rawHashToObject(rawHash);

    return deserializeMessage(id, rawObject);
  },

  /**
   * Move a failed message from any in-flight queue to the retry queue.
   * Updates retry count, delivery status, and failure history.
   * Cleans up the external delivery ID index (will get a new one on retry).
   *
   * Concurrency admission slot cleanup is opt-in via `concurrencyRateLimitKey`
   * (`buildConcurrencyRateLimitKey`) — same seam as `messageFullCleanup`.
   * Callers that omit it (PUSH, or spacing admission) are a no-op for that step.
   */
  async fromAnyToRetry(
    messageId: string,
    currentQueueKey: string,
    nextRetryAt: number,
    updateProps: {
      retryCount: number;
      deliveryStatus: DeviceMessageDeliveryStatus;
      failureHistory: FailureReason[];
    },
    options?: {
      concurrencyRateLimitKey?: string;
    },
  ): Promise<void> {
    const messageKey = redisKeys.message(messageId);

    // Guard: verify the message is still in the expected queue before proceeding.
    // Prevents double-retry when the zombie detector and the sendOneToNetworkServer
    // error handler race on the same message.
    const inQueue = await redisRepo.client.zscore(currentQueueKey, messageId);
    if (inQueue === null) return;

    const [ currentDeliveryQueueId ] = await redisRepo.client.hmget(
      messageKey,
      'deliveryQueueId',
    );

    const pipeline = redisRepo.client.multi();

    // 1. Update message hash (clear deliveryQueueId since it's now stale)
    pipeline.hset(messageKey, {
      retryCount: updateProps.retryCount,
      deliveryStatus: updateProps.deliveryStatus,
      failureHistory: JSON.stringify(updateProps.failureHistory),
    });
    // @RACE-CONDITION :: Deleting this, while the message is already 'selected' by the 'checkStatus'
    // PULL pattern Cron job, will cause that to check the message status for an `undefined` deliveryQueueId → 💥
    pipeline.hdel(messageKey, 'deliveryQueueId');

    // 2. Move between queues
    pipeline.zrem(currentQueueKey, messageId);
    pipeline.zadd(QUEUE_RETRY_KEY, nextRetryAt, messageId);

    // 3. Clean up the stale external delivery ID index
    if (currentDeliveryQueueId) {
      pipeline.del(redisKeys.indexExternalDeliveryId(currentDeliveryQueueId));
    }

    // 4. Concurrency rate-limit membership — caller supplies concurrencyRateLimitKey
    if (options?.concurrencyRateLimitKey) {
      pipeline.srem(options.concurrencyRateLimitKey, messageId);
    }

    await pipeline.exec();
  },
};
