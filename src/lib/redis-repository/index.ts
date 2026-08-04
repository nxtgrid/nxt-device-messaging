import { Redis } from 'iovalkey';
import { ulid } from 'ulid';
import { isEmpty } from 'ramda';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { deserializeMessage, serializeCreateDeviceMessage } from './helpers.js';
import { redisKeys } from './keys.js';
import type {
  CreateDeviceMessage,
  DeviceMessage,
  DeviceMessageDeliveryStatus,
  PhaseEnum,
} from '../device-message/types.js';

import type {
  FetchNextMessageResult,
} from './lua/fetch-next-message-in-queue.types.js';
import type {
  MoveMessageResult,
} from './lua/move-message-between-queues.types.js';

/**
 * TTL for message hashes and their indexes.
 * Covers max retry time (~4 hours) with generous buffer.
 * Acts as safety net if normal cleanup fails.
 */
export const MESSAGE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

declare module 'iovalkey' {
  interface Redis {
    /**
     * Atomically fetches the highest priority message from source queue,
     * moves it to destination queue, updates status, and returns message data.
     *
     * @param source_queue - Source sorted set to pop message from (KEYS[1])
     * @param destination_queue - Destination sorted set to move message to (KEYS[2])
     * @param queues_to_distribute_from - Set tracking which queues have work (KEYS[3])
     * @param timeout_at - Unix timestamp for timeout in destination queue (ARGV[1])
     * @param new_status - New delivery status to set on message (ARGV[2])
     * @returns Promise resolving to [messageId, fields[]] or null if queue empty
     */
    fetchNextMessageInQueueAndMove(
      source_queue: string,
      destination_queue: string,
      queues_to_distribute_from: string,
      timeout_at: number | string,
      new_status: DeviceMessageDeliveryStatus,
    ): Promise<FetchNextMessageResult>;

    /**
     * Atomically moves a message between queues with a stale-message guard.
     * Only proceeds if the message is present in the source queue (ZREM gate).
     *
     * @param source_queue - Source sorted set (KEYS[1])
     * @param destination_queue - Destination sorted set (KEYS[2])
     * @param message_key - Message hash key (KEYS[3])
     * @param index_key - Optional index key, '' to skip (KEYS[4])
     * @param message_id - Message ULID (ARGV[1])
     * @param destination_score - Score for destination queue (ARGV[2])
     * @param deliveryStatus - New delivery status (ARGV[3])
     * @param deliveryQueueId - New delivery queue ID, '' to skip (ARGV[4])
     * @param index_ttl_seconds - TTL for index key (ARGV[5])
     * @returns 0 if message not in source queue, 1 if moved
     */
    moveMessageBetweenQueues(
      source_queue: string,
      destination_queue: string,
      message_key: string,
      index_key: string,
      message_id: string,
      destination_score: number | string,
      deliveryStatus: DeviceMessageDeliveryStatus,
      deliveryQueueId: string,
      index_ttl_seconds: number | string,
    ): Promise<MoveMessageResult>;
  }
}

/**
 * Builds iovalkey client options from `REDIS_*` env (ADR-002 §8).
 */
function createRedisClientOptions() {
  const host = process.env.REDIS_HOST ?? '127.0.0.1';
  const port = parseInt(process.env.REDIS_PORT ?? '6379', 10);
  const username = process.env.REDIS_USERNAME;
  const password = process.env.REDIS_PASSWORD;
  const db = parseInt(process.env.REDIS_DB ?? '0', 10);
  const tlsEnabled = process.env.REDIS_TLS === 'true' || process.env.REDIS_TLS === '1';

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid REDIS_PORT "${ process.env.REDIS_PORT }"; expected positive integer`);
  }
  if (!Number.isFinite(db) || db < 0) {
    throw new Error(`Invalid REDIS_DB "${ process.env.REDIS_DB }"; expected non-negative integer`);
  }

  return {
    host,
    port,
    ...(username !== undefined && username !== '' ? { username } : {}),
    ...(password !== undefined && password !== '' ? { password } : {}),
    db,
    ...(tlsEnabled ? { tls: {} } : {}),
  };
}

const luaDir = join(dirname(fileURLToPath(import.meta.url)), 'lua');
const fetchNextLua = readFileSync(join(luaDir, 'fetch-next-message-in-queue.lua'), 'utf-8');
const moveBetweenLua = readFileSync(join(luaDir, 'move-message-between-queues.lua'), 'utf-8');

const _client = new Redis(createRedisClientOptions());

const addScripts = (): void => {
  _client.defineCommand('fetchNextMessageInQueueAndMove', {
    numberOfKeys: 3,
    lua: fetchNextLua,
  });
  _client.defineCommand('moveMessageBetweenQueues', {
    numberOfKeys: 4,
    lua: moveBetweenLua,
  });
};

addScripts();

_client.on('connect', () => {
  console.info('[REDIS REPOSITORY :: CONNECTED]');
});

/**
 * Redis data access layer for device messages.
 *
 * Data structures:
 * - Hash: device_message:{id} → message fields (the main entity)
 * - Sorted Set: queue:* → message IDs sorted by priority or timeout
 * - Set: queues_to_distribute_from → list of active initial queues
 * - String: idx:* → lookup indexes (correlation id, external delivery id)
 * - String: lock_queue:* → distributed locks with TTL
 */
export const redisRepo = {
  /** Raw Redis client for advanced operations (queue Lua scripts, pipelines). */
  client: _client,

  /**
   * Create a new message and add it to the appropriate initial queue.
   * Atomic operation using Redis pipeline.
   *
   * @param dto - Message creation parameters
   * @param queueKey - Initial queue to add message to
   * @returns The newly created DeviceMessage
   */
  async enqueueDeviceMessage(
    dto: CreateDeviceMessage,
    queueKey: string,
  ): Promise<DeviceMessage> {
    const messageId = ulid();
    const messageKey = redisKeys.message(messageId);
    const serializedHash = serializeCreateDeviceMessage(dto);

    const pipeline = _client.pipeline();

    // 1. Store the message hash
    pipeline.hset(messageKey, serializedHash);
    pipeline.expire(messageKey, MESSAGE_TTL_SECONDS);

    // 2. Add to the appropriate initial queue
    const score = -1 * dto.priority;
    pipeline.zadd(queueKey, score, messageId);

    // 3. Tell the distributor there is work in this queue
    pipeline.sadd(redisKeys.listOfInitialQueuesToDistributeFrom(), queueKey);

    // 4. Create correlation indexes (optionally per phase)
    if (dto.correlationId) {
      const indexKey = redisKeys.indexCorrelationId(dto.correlationId, dto.phase);
      pipeline.set(indexKey, messageKey, 'EX', MESSAGE_TTL_SECONDS);
    }

    await pipeline.exec();

    return deserializeMessage(messageId, {
      ...Object.fromEntries(
        Object.entries(serializedHash).map(([ key, value ]) => [ key, String(value) ]),
      ),
    });
  },

  /**
   * Move a message from retry queue back to an initial queue.
   * Restores priority-based ordering and marks as QUEUED.
   *
   * @param messageId - ULID of the message
   * @param fromQueueKey - Source queue (typically retry queue)
   * @param toQueueKey - Destination initial queue
   * @param priority - Original message priority
   */
  async requeueMessage(
    messageId: string,
    fromQueueKey: string,
    toQueueKey: string,
    priority: number,
  ): Promise<void> {
    const pipeline = _client.pipeline();

    pipeline.zrem(fromQueueKey, messageId);
    const score = -1 * priority;
    pipeline.zadd(toQueueKey, score, messageId);
    pipeline.sadd(redisKeys.listOfInitialQueuesToDistributeFrom(), toQueueKey);
    pipeline.hset(redisKeys.message(messageId), { deliveryStatus: 'QUEUED' });

    await pipeline.exec();
  },

  /**
   * Get all initial queues that have messages waiting to be distributed.
   * @returns Array of queue keys (e.g. `queue:{pluginId}:{kind}:{id}`)
   */
  fetchQueuesWithMessages(): Promise<string[]> {
    return _client.smembers(redisKeys.listOfInitialQueuesToDistributeFrom());
  },

  /**
   * Acquire a time-limited distributed lock on a queue.
   * Uses SET NX PX for atomic lock with automatic expiry.
   *
   * @param queueKey - Lock key for the queue
   * @param durationMs - Lock duration in milliseconds
   * @returns 'OK' if lock acquired, null if already locked
   */
  lockQueueForTimeMs(queueKey: string, durationMs: number) {
    return _client.set(queueKey, 'locked', 'PX', durationMs, 'NX');
  },

  /**
   * Look up a message ID by its external delivery queue ID (from the network server).
   *
   * @param deliveryQueueId - External queue ID
   * @returns Message ULID or undefined if not found
   */
  async getMessageIdFromDeliveryQueueId(deliveryQueueId: string): Promise<string | undefined> {
    const messageKey = await _client.get(redisKeys.indexExternalDeliveryId(deliveryQueueId));
    return messageKey?.split(':')[1];
  },

  /**
   * Retrieve a full message by its ULID.
   *
   * @param messageId - Message ULID
   * @returns Deserialized DeviceMessage or null if not found
   */
  async getMessageById(messageId: string): Promise<DeviceMessage | null> {
    const raw = await _client.hgetall(redisKeys.message(messageId));
    if (isEmpty(raw)) return null;
    return deserializeMessage(messageId, raw as Record<string, string>);
  },

  /**
   * Retrieve specific raw properties from a message hash.
   * More efficient than getMessageById when only a few fields are needed.
   *
   * @param messageId - Message ULID
   * @param props - Array of property names to retrieve
   * @returns Array of raw string values (null for missing props)
   */
  getMessageRawPropsById(messageId: string, props: string[]): Promise<Array<string | null>> {
    return _client.hmget(redisKeys.message(messageId), ...props);
  },

  /**
   * Look up a message by its associated correlation id.
   *
   * @param correlationId - Caller-supplied correlation id
   * @returns DeviceMessage or null if not found
   */
  async getMessageFromCorrelationId(correlationId: string): Promise<DeviceMessage | null> {
    const messageKey = await _client.get(redisKeys.indexCorrelationId(correlationId));
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
    const messageKeys = (await _client.mget(...indexKeys)).filter(Boolean) as string[];
    if (isEmpty(messageKeys)) return [];

    const pipeline = _client.pipeline();
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
   * Get all message IDs from a queue (sorted set).
   *
   * @param queueKey - Queue to read from
   * @returns Array of message IDs
   */
  getAllMessageIdsInQueue(queueKey: string): Promise<string[]> {
    return _client.zrange(queueKey, 0, '-1');
  },

  /**
   * Find messages that have exceeded their timeout in a queue.
   * Uses sorted set scores as timeout timestamps.
   *
   * @param queueKey - Queue to scan
   * @param cutoffDate - Unix timestamp; messages with score <= this are expired
   * @returns Array of message IDs (max 50 per call)
   */
  getExpiredMessagesInQueue(queueKey: string, cutoffDate: number): Promise<string[]> {
    return _client.zrangebyscore(queueKey, '-inf', cutoffDate, 'LIMIT', 0, 50);
  },

  /**
   * Get messages due for polling in a PULL pattern queue.
   * Returns messages whose score (next poll time) is <= now.
   *
   * @param queueKey - Queue to scan
   * @returns Array of message IDs due for polling (max 50 per call)
   */
  getMessagesDueForPolling(queueKey: string): Promise<string[]> {
    return _client.zrangebyscore(queueKey, '-inf', Date.now(), 'LIMIT', 0, 50);
  },

  /**
   * Update the next poll time for a message in a PULL pattern queue.
   * Uses XX flag to only update if the member exists (prevents race conditions).
   *
   * @param queueKey - Queue containing the message
   * @param messageId - Message ULID
   * @param nextPollAt - Unix timestamp for next poll
   */
  updateNextPollTime(queueKey: string, messageId: string, nextPollAt: number) {
    return _client.zadd(queueKey, 'XX', nextPollAt, messageId);
  },

  /**
   * Remove a message from a specific queue.
   *
   * @param queueKey - Queue to remove from
   * @param messageId - Message ULID to remove
   */
  removeMessageFromQueue(queueKey: string, messageId: string) {
    return _client.zrem(queueKey, messageId);
  },

  /**
   * Complete cleanup of a message from all Redis structures.
   * Called on successful delivery or permanent failure.
   * Removes: message hash, in-flight queue entries, indexes, optional concurrency slot.
   *
   * Unit 2 interim (ADR-006 D2):
   * - `inFlightQueueKeys` — queues to ZREM (defaults to known stage keys + awaiting-task).
   * - `concurrencyRateLimitKey` — optional Redis key to SREM (from
   *   `buildConcurrencyRateLimitKey(initialQueueKey)` when releasing a concurrency slot).
   *
   * @param message - The message to clean up
   * @param options - Optional D2 cleanup seams
   */
  async messageFullCleanup(
    message: DeviceMessage,
    options?: {
      inFlightQueueKeys?: readonly string[];
      concurrencyRateLimitKey?: string;
    },
  ): Promise<void> {
    const messageKey = redisKeys.message(message.id);

    const indexesToDelete = [
      message.correlationId && redisKeys.indexCorrelationId(message.correlationId, message.phase),
      message.deliveryQueueId && redisKeys.indexExternalDeliveryId(message.deliveryQueueId),
    ].filter(Boolean) as string[];

    const inFlightQueueKeys = options?.inFlightQueueKeys ?? [
      'queue_in_flight_to_ns',
      'queue_in_flight_to_relay_node',
      'queue_in_flight_to_device',
      redisKeys.queueAwaitingTask(message.pluginId),
    ];

    const pipeline = _client.multi();

    // 1. Delete the message
    pipeline.del(messageKey);

    // 2. Remove from queues (shotgun only over caller-provided / default keys)
    for (const queueKey of inFlightQueueKeys) {
      pipeline.zrem(queueKey, message.id);
    }

    // 3. Clean up concurrency rate-limit set when the caller supplies the key
    if (options?.concurrencyRateLimitKey) {
      pipeline.srem(options.concurrencyRateLimitKey, message.id);
    }

    // 4. Delete indexes
    for (const indexKey of indexesToDelete) {
      pipeline.del(indexKey);
    }

    await pipeline.exec();
  },

  // ------------------------------------
  // Concurrency admission strategy — Redis primitives (ADR-006)
  // Key from `buildConcurrencyRateLimitKey(initialQueueKey)`; opaque string here.
  // ------------------------------------

  /**
   * Add a message to a concurrency rate-limit tracking set.
   * Called when a message is successfully claimed under the concurrency strategy.
   *
   * @param concurrencyRateLimitKey - Opaque rate-limit set key
   * @param messageId - The message ULID
   */
  addToConcurrencyRateLimit(concurrencyRateLimitKey: string, messageId: string) {
    return _client.sadd(concurrencyRateLimitKey, messageId);
  },

  /**
   * Get the count of messages currently tracked in a concurrency rate-limit set.
   * Used to check if we can admit more messages.
   *
   * @param concurrencyRateLimitKey - Opaque rate-limit set key
   * @returns Number of messages tracked
   */
  getConcurrencyRateLimitCount(concurrencyRateLimitKey: string) {
    return _client.scard(concurrencyRateLimitKey);
  },

  /**
   * Validate and clean a concurrency rate-limit set by removing members
   * whose message hash no longer exists. Only call when the set is at
   * capacity to avoid unnecessary work.
   *
   * @param concurrencyRateLimitKey - Opaque rate-limit set key
   * @returns Number of live members remaining after cleanup
   */
  async validateAndCleanConcurrencyRateLimit(
    concurrencyRateLimitKey: string,
  ): Promise<number> {
    const members = await _client.smembers(concurrencyRateLimitKey);
    if (members.length === 0) return 0;

    const existsPipeline = _client.pipeline();
    for (const messageId of members) {
      existsPipeline.exists(redisKeys.message(messageId));
    }

    const results = await existsPipeline.exec();
    if (!results) return members.length;
    const deadMembers = members.filter((_member, idx) => {
      const [ err, exists ] = results[idx] as unknown as [unknown, number];
      return !err && exists === 0;
    });

    if (deadMembers.length > 0) {
      await _client.srem(concurrencyRateLimitKey, ...deadMembers);
      console.warn(
        `[validateAndCleanConcurrencyRateLimit] Cleaned ${ deadMembers.length } dead entries from ${ concurrencyRateLimitKey }`,
      );
    }

    return members.length - deadMembers.length;
  },
} as const;

