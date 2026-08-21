/**
 * @fileoverview Redis data access for device messages.
 *
 * {@link createRedisRepo} is the adapter: methods close over an injected client.
 * {@link redisRepo} is the process-wide instance so engine files can keep importing
 * it until C1.4–C1.5 inject the remaining stores. The composition root should hold
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
import { isEmpty } from 'ramda';
import { ulid } from 'ulid';

import type {
  CreateDeviceMessage,
  DeviceMessage,
  PhaseEnum,
} from '../device-message/types.js';
import { createRedisClient } from './client.js';
import { deserializeMessage, serializeCreateDeviceMessage } from './helpers.js';
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
     * Create a new message and add it to the appropriate initial queue.
     * Uses Redis MULTI/EXEC so hash, queue membership, distributor set, and
     * optional correlation index commit as one transaction.
     *
     * @param dto - Message creation parameters
     * @param queueKey - Initial queue to add message to
     * @param ttlSeconds - Hash and correlation-index TTL (`delivery.messageTtlSeconds`)
     * @returns The newly created DeviceMessage
     */
    async enqueueDeviceMessage(
      dto: CreateDeviceMessage,
      queueKey: string,
      ttlSeconds: number,
    ): Promise<DeviceMessage> {
      const messageId = ulid();
      const messageKey = redisKeys.message(messageId);
      const serializedHash = serializeCreateDeviceMessage(dto);

      const multi = client.multi();

      // 1. Store the message hash
      multi.hset(messageKey, serializedHash);
      multi.expire(messageKey, ttlSeconds);

      // 2. Add to the appropriate initial queue.
      // Higher `priority` is more urgent → more negative score → popped first.
      const score = -1 * dto.priority;
      multi.zadd(queueKey, score, messageId);

      // 3. Tell the distributor there is work in this queue
      multi.sadd(redisKeys.listOfInitialQueuesToDistributeFrom(), queueKey);

      // 4. Create correlation indexes (optionally per phase)
      if (dto.correlationId) {
        const indexKey = redisKeys.indexCorrelationId(dto.correlationId, dto.phase);
        multi.set(indexKey, messageKey, 'EX', ttlSeconds);
      }

      assertExecSucceeded(await multi.exec(), 'enqueueDeviceMessage');

      return deserializeMessage(messageId, {
        ...Object.fromEntries(
          Object.entries(serializedHash).map(([ key, value ]) => [ key, String(value) ]),
        ),
      });
    },

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
     * Look up a message ID by its external delivery queue ID (from the network server).
     *
     * @param deliveryQueueId - External queue ID
     * @returns Message ULID or undefined if not found
     */
    async getMessageIdFromDeliveryQueueId(deliveryQueueId: string): Promise<string | undefined> {
      const messageKey = await client.get(redisKeys.indexExternalDeliveryId(deliveryQueueId));
      return messageKey?.split(':')[1];
    },

    /**
     * Retrieve a full message by its ULID.
     *
     * @param messageId - Message ULID
     * @returns Deserialized DeviceMessage or null if not found
     */
    async getMessageById(messageId: string): Promise<DeviceMessage | null> {
      const raw = await client.hgetall(redisKeys.message(messageId));
      if (isEmpty(raw)) return null;
      return deserializeMessage(messageId, raw as Record<string, string>);
    },

    /**
     * Look up a message by its associated correlation id.
     *
     * @param correlationId - Caller-supplied correlation id
     * @returns DeviceMessage or null if not found
     */
    async getMessageFromCorrelationId(correlationId: string): Promise<DeviceMessage | null> {
      const messageKey = await client.get(redisKeys.indexCorrelationId(correlationId));
      const messageId = messageKey?.split(':')[1];
      if (!messageId) return null;
      return this.getMessageById(messageId);
    },

    /**
     * Look up all messages by correlation id (for three-phase aggregation).
     * Checks base index and all phase-specific indexes.
     *
     * @param correlationId - Caller-supplied correlation id
     * @returns Array of DeviceMessages (1 for single-phase, up to 3 for three-phase)
     */
    async getAllMessagesForCorrelationId(correlationId: string): Promise<DeviceMessage[]> {
      const phases: Array<PhaseEnum | undefined> = [ undefined, 'A', 'B', 'C' ];
      const indexKeys = phases.map(phase => redisKeys.indexCorrelationId(correlationId, phase));
      const messageKeys = (await client.mget(...indexKeys)).filter(Boolean) as string[];
      if (isEmpty(messageKeys)) return [];

      const pipeline = client.pipeline();
      messageKeys.forEach(key => pipeline.hgetall(key));
      const results = await pipeline.exec();

      if (!results) return [];

      const messages: DeviceMessage[] = [];
      results.forEach(([ err, raw ], i) => {
        if (err || isEmpty(raw)) return;
        const messageId = messageKeys[i].split(':')[1];
        messages.push(deserializeMessage(messageId, raw as Record<string, string>));
      });

      return messages;
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
 * Process-wide adapter. Engine files import this until C1.4–C1.5 inject the remaining stores.
 * One client: created here, held as a local in `main.ts`.
 */
export const redisRepo = createRedisRepo(createRedisClient());

