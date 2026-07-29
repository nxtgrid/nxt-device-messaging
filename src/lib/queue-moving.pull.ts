/**
 * @fileoverview PULL pattern queue transitions (polling-based, e.g. CALIN API V1/V2).
 *
 * PULL pattern message flow after NS acceptance:
 *
 *   queue_in_flight_to_ns
 *         ↓ fromNsToAwaitingTask
 *   queue_awaiting_task:{pluginId} (score = next poll time)
 *         ↓ polled until success or failure
 *   [cleanup] or [queue_awaiting_retry]
 *
 * For PULL pattern, the sorted set score represents "next poll time" (not timeout).
 * Timeout is handled separately via message age check.
 */

import { getConfig } from '../config/index.js';
import { redisKeys } from './redis-repository/keys.js';
import type { DeviceMessageDeliveryStatus } from './types.js';
import { _moveQueue, QUEUE_NS_KEY } from './queue-moving.js';

/** Awaiting task queue config for PULL pattern adapters. */
const CONFIG_QUEUE_AWAITING_TASK = {
  /** Message status when in this queue */
  MESSAGE_STATUS: 'DELIVERED_TO_NS' as DeviceMessageDeliveryStatus,
};

/**
 * PULL pattern queue transitions.
 */
export const moveQueuePull = {
  /**
   * Move message from NS queue to Awaiting Task queue for a PULL plugin.
   * Used when the external API accepts our request and returns a task ID.
   * The message will be polled until the task completes.
   *
   * Note: For PULL pattern, the score represents "next poll time" (not timeout).
   *
   * @param id - Message ULID
   * @param delivery_queue_id - External task ID from the API (e.g. CALIN TaskNo)
   * @param pluginId - Opaque plugin id (determines `queue_awaiting_task:{pluginId}`)
   */
  async fromNsToAwaitingTask({
    id,
    delivery_queue_id,
    pluginId,
  }: {
    id: string;
    delivery_queue_id: string;
    pluginId: string;
  }): Promise<void> {
    const queueKey = redisKeys.queueAwaitingTask(pluginId);
    const firstPollAt = Date.now() + getConfig().delivery.initialPollDelayMs;
    await _moveQueue(
      id,
      QUEUE_NS_KEY,
      queueKey,
      firstPollAt,
      {
        delivery_status: CONFIG_QUEUE_AWAITING_TASK.MESSAGE_STATUS,
        delivery_queue_id,
      },
      redisKeys.indexExternalDeliveryId(delivery_queue_id),
    );
  },
};
