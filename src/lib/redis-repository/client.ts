/**
 * @fileoverview Redis client (ADR-002 §8).
 *
 * Lua commands are registered here so every caller sees
 * `fetchNextMessageInQueueAndMove` / `moveMessageBetweenQueues` on the type.
 * {@link redis} is the one process-wide connection — main and tests import it.
 * {@link createRedisClient} builds another connection; do not call it in the
 * same process as {@link redis}.
 */

import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Redis } from 'iovalkey';

import { logger } from '../../log.js';
import type { DeviceMessageDeliveryStatus } from '../device-message/types.js';
import type { FetchNextMessageResult } from './lua/fetch-next-message-in-queue.types.js';
import type { MoveMessageResult } from './lua/move-message-between-queues.types.js';

declare module 'iovalkey' {
  interface Redis {
    /**
     * Atomically fetches the highest priority message from source queue,
     * moves it to destination queue, updates status, and returns message data.
     *
     * @param source_queue - Source sorted set to pop message from (KEYS[1])
     * @param destination_queue - Destination sorted set to move message to (KEYS[2])
     * @param queues_to_distribute_from - Set tracking which queues have work (KEYS[3])
     * @param concurrency_set - Concurrency track set, or '' to skip the cap (KEYS[4])
     * @param timeout_at - Unix timestamp for timeout in destination queue (ARGV[1])
     * @param new_status - New delivery status to set on message (ARGV[2])
     * @param max_in_flight - Cap for KEYS[4]; ignored when KEYS[4] is '' (ARGV[3])
     * @returns Promise resolving to [messageId, fields[]] or null if queue empty / at cap
     */
    fetchNextMessageInQueueAndMove(
      source_queue: string,
      destination_queue: string,
      queues_to_distribute_from: string,
      concurrency_set: string,
      timeout_at: number | string,
      new_status: DeviceMessageDeliveryStatus,
      max_in_flight: number | string,
    ): Promise<FetchNextMessageResult>;

    /**
     * Atomically moves a message between queues with a stale-message guard.
     * Proceeds only if the id is in the source queue (ZREM) and the hash still
     * exists (EXISTS) — matches fetch-next orphan handling.
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
     * @returns 0 if not in source queue or hash missing, 1 if moved
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

const luaDir = join(dirname(fileURLToPath(import.meta.url)), 'lua');
const fetchNextLua = readFileSync(join(luaDir, 'fetch-next-message-in-queue.lua'), 'utf-8');
const moveBetweenLua = readFileSync(join(luaDir, 'move-message-between-queues.lua'), 'utf-8');

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

/**
 * One Redis client with the queue Lua commands registered.
 *
 * Prefer {@link redis}. A second call is a second connection.
 *
 * @returns Connected iovalkey client
 */
export function createRedisClient(): Redis {
  const client = new Redis(createRedisClientOptions());

  client.defineCommand('fetchNextMessageInQueueAndMove', {
    numberOfKeys: 4,
    lua: fetchNextLua,
  });
  client.defineCommand('moveMessageBetweenQueues', {
    numberOfKeys: 4,
    lua: moveBetweenLua,
  });

  client.on('connect', () => {
    logger.info({ module: 'redis' }, 'connected');
  });
  client.on('error', err => {
    logger.error({ module: 'redis', err }, 'client error');
  });

  return client;
}

/**
 * Process-wide client. Main and tests import this so they share one connection.
 */
export const redis = createRedisClient();

