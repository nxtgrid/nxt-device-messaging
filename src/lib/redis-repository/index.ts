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
} from '../types.js';

import type {
  FetchNextMessageResult,
} from './lua/fetch-next-message-in-queue.types.js';
import type {
  MoveMessageResult,
} from './lua/move-message-between-queues.types.js';

export const MESSAGE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

declare module 'iovalkey' {
  interface Redis {
    /**
     * Atomically fetches the highest priority message from source queue,
     * moves it to destination queue, updates status, and returns message data.
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
     * Returns 0 if the message wasn't moved, 1 if it was moved.
     */
    moveMessageBetweenQueues(
      source_queue: string,
      destination_queue: string,
      message_key: string,
      index_key: string,
      message_id: string,
      destination_score: number | string,
      delivery_status: DeviceMessageDeliveryStatus,
      delivery_queue_id: string,
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

  async enqueueDeviceMessage(dto: CreateDeviceMessage, queueKey: string): Promise<void> {
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
    if (dto.correlation_id) {
      const indexKey = redisKeys.indexCorrelationId(dto.correlation_id, dto.phase);
      pipeline.set(indexKey, messageKey, 'EX', MESSAGE_TTL_SECONDS);
    }

    await pipeline.exec();
  },

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
    pipeline.hset(redisKeys.message(messageId), { delivery_status: 'QUEUED' });

    await pipeline.exec();
  },

  fetchQueuesWithMessages(): Promise<string[]> {
    return _client.smembers(redisKeys.listOfInitialQueuesToDistributeFrom());
  },

  lockQueueForTimeMs(queueKey: string, durationMs: number) {
    return _client.set(queueKey, 'locked', 'PX', durationMs, 'NX');
  },

  async getMessageIdFromDeliveryQueueId(deliveryQueueId: string): Promise<string | undefined> {
    const messageKey = await _client.get(redisKeys.indexExternalDeliveryId(deliveryQueueId));
    return messageKey?.split(':')[1];
  },

  async getMessageById(messageId: string): Promise<DeviceMessage | null> {
    const raw = await _client.hgetall(redisKeys.message(messageId));
    if (isEmpty(raw)) return null;
    return deserializeMessage(messageId, raw as Record<string, string>);
  },

  getMessageRawPropsById(messageId: string, props: string[]): Promise<Array<string | null>> {
    return _client.hmget(redisKeys.message(messageId), ...props);
  },

  async getMessageFromCorrelationId(correlationId: string): Promise<DeviceMessage | null> {
    const messageKey = await _client.get(redisKeys.indexCorrelationId(correlationId));
    const messageId = messageKey?.split(':')[1];
    if (!messageId) return null;
    return this.getMessageById(messageId);
  },

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

  getAllMessageIdsInQueue(queueKey: string): Promise<string[]> {
    return _client.zrange(queueKey, 0, '-1');
  },

  getExpiredMessagesInQueue(queueKey: string, cutoffDate: number): Promise<string[]> {
    return _client.zrangebyscore(queueKey, '-inf', cutoffDate, 'LIMIT', 0, 50);
  },

  getMessagesDueForPolling(queueKey: string): Promise<string[]> {
    return _client.zrangebyscore(queueKey, '-inf', Date.now(), 'LIMIT', 0, 50);
  },

  updateNextPollTime(queueKey: string, messageId: string, nextPollAt: number) {
    return _client.zadd(queueKey, 'XX', nextPollAt, messageId);
  },

  removeMessageFromQueue(queueKey: string, messageId: string) {
    return _client.zrem(queueKey, messageId);
  },

  /**
   * Complete cleanup of a message from all Redis structures.
   *
   * Called on successful delivery or permanent failure.
   *
   * Unit 2 interim (ADR-006 D2):
   * - `inFlightQueueKeys` — queues to ZREM (defaults to known stage keys + awaiting-task).
   * - `concurrencyRateLimitKey` — optional set to SREM (caller/plugin `trackKey`; no
   *   gateway default — core does not invent concurrency keys).
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
      message.correlation_id && redisKeys.indexCorrelationId(message.correlation_id, message.phase),
      message.delivery_queue_id && redisKeys.indexExternalDeliveryId(message.delivery_queue_id),
    ].filter(Boolean) as string[];

    const inFlightQueueKeys = options?.inFlightQueueKeys ?? [
      'queue_in_flight_to_ns',
      'queue_in_flight_to_gw',
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
  // Opaque `trackKey` comes from the plugin; core does not build gateway keys.
  // ------------------------------------

  addToConcurrencyRateLimit(trackKey: string, messageId: string) {
    return _client.sadd(trackKey, messageId);
  },

  getConcurrencyRateLimitCount(trackKey: string) {
    return _client.scard(trackKey);
  },

  async validateAndCleanConcurrencyRateLimit(trackKey: string): Promise<number> {
    const members = await _client.smembers(trackKey);
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
      await _client.srem(trackKey, ...deadMembers);
      console.warn(`[REDIS] Cleaned ${ deadMembers.length } dead entries from ${ trackKey }`);
    }

    return members.length - deadMembers.length;
  },
} as const;

