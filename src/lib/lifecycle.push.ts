/**
 * @fileoverview PUSH pattern lifecycle management (webhook-based, e.g. LoRaWAN/ChirpStack).
 *
 * Handles:
 * - Timeout scanning for PUSH in-flight queues (GW + Device)
 * - GW queue extension (check remote status before retrying)
 *
 * Functions return data; side effects (retryOrFail) are handled by the caller.
 */

import type { DeliveryConfig } from '../config/schema.js';
import { redisRepo } from './redis-repository/index.js';
import type { DeviceMessage, ParsedIncomingEvent } from './types.js';
import { PUSH_QUEUE_KEYS, PUSH_TIMEOUT_REASONS, moveQueuePush } from './queue-moving.push.js';


/**
 * Interim structural minimum for PUSH ingress (Unit 4).
 * Deleted at Unit 6 in favour of `DeviceMessagingPlugin` / `plugin.incoming`.
 */
export type PushIncoming = {
  handle(event: unknown): ParsedIncomingEvent | null;
};

/**
 * Interim structural minimum for GW remote-status checks (Unit 4).
 * Deleted at Unit 6 in favour of `DeviceMessagingPlugin` / `plugin.outgoing`.
 */
export type PushOutgoing = {
  getRemoteStatus(
    message: DeviceMessage,
  ): Promise<{ delivery_status: string }> | { delivery_status: string };
};

/** Result of a PUSH pattern timeout: a message that needs retryOrFail. */
export type PushTimeoutResult = {
  messageId: string;
  queueKey: string;
  reason: string;
};

/**
 * Find PUSH pattern messages that have timed out in GW and Device queues.
 * Returns all expired messages — the caller decides how to handle them
 * (e.g. GW queue messages may need remote status checking before retrying).
 *
 * @param now - Current timestamp
 * @returns Array of timed-out messages with their queue and reason
 */
export async function getPushTimeouts(now: number): Promise<PushTimeoutResult[]> {
  const results: PushTimeoutResult[] = [];

  for (const queueKey of PUSH_QUEUE_KEYS) {
    const zombieIds = await redisRepo.getExpiredMessagesInQueue(queueKey, now);

    if (zombieIds.length === 0) continue;

    for (const messageId of zombieIds) {
      const reason = PUSH_TIMEOUT_REASONS[queueKey] ?? `Timed out in unknown queue: ${ queueKey }`;
      results.push({ messageId, queueKey, reason });
    }
  }

  return results;
}

/**
 * Check if a message in GW queue is still queued remotely.
 * If yes, extend the timeout. If no (or error), return false to proceed with retryOrFail.
 *
 * @param messageId - ULID of the message
 * @param message - The full message (already fetched by caller)
 * @param plugin - Plugin (or structural minimum with `getRemoteStatus`)
 * @param deliveryConfig - Shared delivery knobs (GW timeout)
 * @returns true if timeout was extended, false if should proceed to retryOrFail
 */
export async function maybeExtendMessageInGwQueue(
  messageId: string,
  message: DeviceMessage,
  plugin: PushOutgoing,
  deliveryConfig: DeliveryConfig,
): Promise<boolean> {
  try {
    const { delivery_status } = await plugin.getRemoteStatus(message);
    if (delivery_status === 'DELIVERY_FAILED') return false;
  }
  catch (err) {
    console.error('[DEVICE MESSAGING] Error checking status for message', message, err);
    return false;
  }

  await moveQueuePush.extendGwQueueTimeout(messageId, deliveryConfig);
  return true;
}
