/**
 * @fileoverview Redis data access for device messages.
 *
 * {@link createRedisRepo} is the adapter: methods close over an injected client.
 * {@link redisRepo} is the process-wide instance so engine files can keep importing
 * it until C1.5 injects StageStore. The composition root should hold
 * `redisRepo.client` as a local (metrics, webhook store, quit) rather than reaching
 * through this object for the raw connection.
 *
 * Data structures:
 * - Hash: device_message:{id} → message fields (the main entity)
 * - Sorted Set: queue:* → message IDs sorted by priority or timeout
 * - Set: queues_to_distribute_from → list of active initial queues
 * - String: idx:* → lookup indexes (correlation id, external delivery id)
 * - String: lock_queue:* → distributed locks with TTL
 */

import { Redis } from 'iovalkey';

import type { DeviceMessage } from '../device-message/types.js';
import { createRedisClient } from './client.js';
import { redisKeys } from './keys.js';

export { createRedisClient } from './client.js';

/**
 * Max members returned per timeout / poll scan (`ZRANGEBYSCORE … LIMIT`).
 * Caps work per engine tick; leftover due members wait for the next tick.
 * Inherited from legacy — pragmatic batch size, not a measured optimum.
 */
const QUEUE_SCAN_BATCH_SIZE = 50;

/**
 * Fail if a MULTI/EXEC (or pipeline) reply is missing or any command errored.
 *
 * @param results - `exec()` reply (`null` if the transaction was aborted)
 * @param operation - Label for the error message
 */
function assertExecSucceeded(
  results: [Error | null, unknown][] | null,
  operation: string,
): void {
  if (results === null) {
    throw new Error(`[REDIS] ${ operation } aborted (MULTI/EXEC returned null)`);
  }
  for (const [ err ] of results) {
    if (err) {
      throw err instanceof Error
        ? err
        : new Error(`[REDIS] ${ operation } failed: ${ String(err) }`);
    }
  }
}

/**
 * Device-message Redis adapter over an injected client.
 *
 * @param client - Process Redis connection (Lua commands already registered)
 */
export function createRedisRepo(client: Redis) {
  return {
    /** Raw Redis client for Lua scripts, pipelines, and shutdown. */
    client,

    /**
     * Move a message from retry queue back to an initial queue.
     * Restores priority-based ordering and marks as QUEUED.
     * Uses Redis MULTI/EXEC for the queue move + status update.
     *
     * @param messageId - ULID of the message
     * @param fromQueueKey - Source queue (typically retry queue)
     * @param toQueueKey - Destination initial queue
     * @param priority - Original message priority (higher = more urgent; score `-priority`)
     */
    async requeueMessage(
      messageId: string,
      fromQueueKey: string,
      toQueueKey: string,
      priority: number,
    ): Promise<void> {
      const multi = client.multi();

      multi.zrem(fromQueueKey, messageId);
      const score = -1 * priority;
      multi.zadd(toQueueKey, score, messageId);
      multi.sadd(redisKeys.listOfInitialQueuesToDistributeFrom(), toQueueKey);
      multi.hset(redisKeys.message(messageId), { deliveryStatus: 'QUEUED' });

      assertExecSucceeded(await multi.exec(), 'requeueMessage');
    },

    /**
     * Get all initial queues that have messages waiting to be distributed.
     * @returns Array of queue keys (e.g. `queue:{pluginId}:{kind}:{id}`)
     */
    fetchQueuesWithMessages(): Promise<string[]> {
      return client.smembers(redisKeys.listOfInitialQueuesToDistributeFrom());
    },

    /**
     * Find messages that have exceeded their timeout in a queue.
     * Uses sorted set scores as timeout timestamps.
     *
     * @param queueKey - Queue to scan
     * @param cutoffDate - Unix timestamp; messages with score <= this are expired
     * @returns Array of message IDs (max {@link QUEUE_SCAN_BATCH_SIZE} per call)
     */
    getExpiredMessagesInQueue(queueKey: string, cutoffDate: number): Promise<string[]> {
      return client.zrangebyscore(queueKey, '-inf', cutoffDate, 'LIMIT', 0, QUEUE_SCAN_BATCH_SIZE);
    },

    /**
     * Remove a message from a specific queue.
     *
     * @param queueKey - Queue to remove from
     * @param messageId - Message ULID to remove
     */
    removeMessageFromQueue(queueKey: string, messageId: string) {
      return client.zrem(queueKey, messageId);
    },

    /**
     * Delete a message and every reference to it, in one MULTI.
     *
     * Which queues those are is not decided here: the caller passes them, because the set
     * of places a message can be is the stage table's business and a second hand-written
     * list is precisely how this function came to miss two of them (A4). `StageMoves.purge`
     * is the one place that derives it.
     *
     * `queues_to_distribute_from` is deliberately untouched — it holds queue keys rather
     * than message ids, and the distributor's Lua drops a key when its queue empties.
     *
     * @param message - The message to clean up (indexes and admission slot come from it)
     * @param queueKeys - Every queue that could hold this message as a member
     */
    async messageFullCleanup(
      message: DeviceMessage,
      queueKeys: readonly string[],
    ): Promise<void> {
      const messageKey = redisKeys.message(message.id);

      const indexesToDelete = [
        message.correlationId && redisKeys.indexCorrelationId(message.correlationId, message.phase),
        message.deliveryQueueId && redisKeys.indexExternalDeliveryId(message.deliveryQueueId),
      ].filter(Boolean) as string[];

      const multi = client.multi();

      // 1. Delete the message
      multi.del(messageKey);

      // 2. Remove from every queue the caller named
      for (const queueKey of queueKeys) {
        multi.zrem(queueKey, message.id);
      }

      // 3. Release concurrency admission slot (key stored on the message at claim)
      if (message.concurrencyRateLimitKey) {
        multi.srem(message.concurrencyRateLimitKey, message.id);
      }

      // 4. Delete indexes
      for (const indexKey of indexesToDelete) {
        multi.del(indexKey);
      }

      assertExecSucceeded(await multi.exec(), 'messageFullCleanup');
    },
  };
}

/** Device-message Redis adapter (injected client). */
export type RedisRepo = ReturnType<typeof createRedisRepo>;

/**
 * Process-wide adapter. Engine files import this until C1.5 injects StageStore.
 * One client: created here, held as a local in `main.ts`.
 */
export const redisRepo = createRedisRepo(createRedisClient());

