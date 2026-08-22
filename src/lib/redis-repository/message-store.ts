/**
 * @fileoverview Redis port for message hash + lookup indexes (plan 002 C1).
 *
 * Enqueue, get-by-id, get-by-correlation, get-all-for-correlation, and the
 * delivery-queue-id index. Stage moves and admission are other ports.
 */

import type { Redis } from 'iovalkey';
import { isEmpty } from 'ramda';
import { ulid } from 'ulid';

import { PHASES } from '../device-message/schemas.js';
import type { CreateDeviceMessage, DeviceMessage } from '../device-message/types.js';
import { assertExecSucceeded } from './assert-exec.js';
import { deserializeMessage, serializeCreateDeviceMessage } from './helpers.js';
import { redisKeys } from './keys.js';

/** Redis operations for the message hash and its lookup indexes. */
export type MessageStore = {
  /**
   * Create a message and add it to an initial queue.
   * Hash, queue membership, distributor set, and optional correlation index
   * commit as one MULTI.
   *
   * @param dto - Message creation parameters
   * @param queueKey - Initial queue to add the message to
   * @param ttlSeconds - Hash and correlation-index TTL (`delivery.messageTtlSeconds`)
   */
  enqueueDeviceMessage(
    dto: CreateDeviceMessage,
    queueKey: string,
    ttlSeconds: number,
  ): Promise<DeviceMessage>;
  /**
   * Look up a message ID by its external delivery queue ID.
   *
   * @param deliveryQueueId - External queue ID
   */
  getMessageIdFromDeliveryQueueId(
    deliveryQueueId: string,
  ): Promise<string | undefined>;
  /**
   * Retrieve a full message by its ULID.
   *
   * @param messageId - Message ULID
   */
  getMessageById(messageId: string): Promise<DeviceMessage | null>;
  /**
   * Look up a message by its associated correlation id.
   *
   * @param correlationId - Caller-supplied correlation id
   */
  getMessageFromCorrelationId(
    correlationId: string,
  ): Promise<DeviceMessage | null>;
  /**
   * Look up all messages by correlation id (base index plus phases A/B/C).
   *
   * @param correlationId - Caller-supplied correlation id
   */
  getAllMessagesForCorrelationId(
    correlationId: string,
  ): Promise<DeviceMessage[]>;
};

/** Dependencies for {@link createMessageStore}. */
export type CreateMessageStoreOptions = {
  readonly client: Redis;
};

/**
 * Factory for message Redis access (injected client).
 *
 * @param options - Redis client (same instance as the rest of the process)
 */
export function createMessageStore(
  options: CreateMessageStoreOptions,
): MessageStore {
  const { client } = options;

  async function getMessageById(messageId: string): Promise<DeviceMessage | null> {
    const raw = await client.hgetall(redisKeys.message(messageId));
    if (isEmpty(raw)) return null;
    return deserializeMessage(messageId, raw as Record<string, string>);
  }

  return {
    async enqueueDeviceMessage(dto, queueKey, ttlSeconds) {
      const messageId = ulid();
      const messageKey = redisKeys.message(messageId);
      const serializedHash = serializeCreateDeviceMessage(dto);

      const multi = client.multi();

      multi.hset(messageKey, serializedHash);
      multi.expire(messageKey, ttlSeconds);

      const score = -1 * dto.priority;
      multi.zadd(queueKey, score, messageId);

      multi.sadd(redisKeys.listOfInitialQueuesToDistributeFrom(), queueKey);

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

    async getMessageIdFromDeliveryQueueId(deliveryQueueId) {
      const messageKey = await client.get(redisKeys.indexExternalDeliveryId(deliveryQueueId));
      return redisKeys.messageIdFromKey(messageKey);
    },

    getMessageById,

    async getMessageFromCorrelationId(correlationId) {
      const messageKey = await client.get(redisKeys.indexCorrelationId(correlationId));
      const messageId = redisKeys.messageIdFromKey(messageKey);
      if (!messageId) return null;
      return getMessageById(messageId);
    },

    async getAllMessagesForCorrelationId(correlationId) {
      const indexPhases = [ undefined, ...PHASES ] as const;
      const indexKeys = indexPhases.map(phase => redisKeys.indexCorrelationId(correlationId, phase));
      const messageKeys = (await client.mget(...indexKeys)).filter(Boolean) as string[];
      if (isEmpty(messageKeys)) return [];

      const pipeline = client.pipeline();
      messageKeys.forEach(key => pipeline.hgetall(key));
      const results = await pipeline.exec();

      if (!results) return [];

      const messages: DeviceMessage[] = [];
      results.forEach(([ err, raw ], i) => {
        if (err || isEmpty(raw)) return;
        const messageId = redisKeys.messageIdFromKey(messageKeys[i]);
        if (!messageId) return;
        messages.push(deserializeMessage(messageId, raw as Record<string, string>));
      });

      return messages;
    },
  };
}
