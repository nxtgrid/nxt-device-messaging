/**
 * @fileoverview PUSH pattern lifecycle management (webhook-based, e.g. LoRaWAN/ChirpStack).
 *
 * Handles:
 * - Timeout scanning for PUSH in-flight queues (relay-node + device)
 * - Relay-node queue extension (check remote status before retrying)
 *
 * Functions return data; side effects (retryOrFail) are handled by the caller.
 */

import { decodeTime } from 'ulid';

import type { StageMoves } from '../engine/lifecycle/moves.js';
import { STAGES } from '../engine/lifecycle/stages.js';
import { logger } from '../log.js';
import type { PushPlugin } from '../plugins/plugin.interface.js';
import type { DeviceMessage } from './device-message/types.js';
import { redisRepo } from './redis-repository/index.js';

/** PUSH pattern in-flight queue keys (for timeout scanning). */
export const PUSH_QUEUE_KEYS = [
  STAGES.relayNode.key(),
  STAGES.device.key(),
] as const;

/** Human-readable timeout reasons for each PUSH queue stage. */
export const PUSH_TIMEOUT_REASONS: Readonly<Record<string, string>> = {
  queue_in_flight_to_relay_node:
    'Timed out waiting for relay node to transmit message to device',
  queue_in_flight_to_device:
    'Timed out waiting for device response after transmission',
};

/** Result of a PUSH pattern timeout: a message that needs retryOrFail. */
export type PushTimeoutResult = {
  messageId: string;
  queueKey: string;
  reason: string;
};

/**
 * Find PUSH pattern messages that have timed out in relay-node and device queues.
 * Returns all expired messages — the caller decides how to handle them
 * (e.g. relay-node queue messages may need remote status checking before retrying).
 *
 * @param now - Current timestamp
 * @returns Array of timed-out messages with their queue key and reason
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
 * Check if a message in the relay-node queue is still queued remotely.
 * If yes, extend the timeout. If no (or error), return false to proceed with retryOrFail.
 *
 * @param messageId - ULID of the message
 * @param message - The full message (already fetched by caller)
 * @param plugin - Owning PUSH plugin (`outgoing.getRemoteStatus` + `tuning`)
 * @param moves - Stage transitions used to reschedule the relay-node wait
 * @returns true if timeout was extended, false if should proceed to retryOrFail
 */
export async function maybeExtendMessageInRelayNodeQueue(
  messageId: string,
  message: DeviceMessage,
  plugin: PushPlugin,
  moves: StageMoves,
): Promise<boolean> {
  const getRemoteStatus = plugin.outgoing.getRemoteStatus;
  if (!getRemoteStatus) return false;

  try {
    const { deliveryStatus } = await getRemoteStatus(message);
    if (deliveryStatus === 'DELIVERY_FAILED') return false;
  }
  catch (err) {
    logger.error({ module: 'lifecycle.push', err, messageId, message }, 'getRemoteStatus failed');
    return false;
  }

  await moves.reschedule({
    stage: STAGES.relayNode,
    message,
    messageAgeMs: Date.now() - decodeTime(message.id),
    plugin,
  });
  return true;
}
