import { type DeviceMessageDeliveryStatus } from '../../types.js';

/**
 * KEYS parameters for move-message-between-queues.lua
 * Redis Lua scripts use KEYS for key names (required for cluster mode).
 */
export type MoveMessageKeys = [
  sourceQueue: string,
  destinationQueue: string,
  messageKey: string,
  indexKey: string,
];

/**
 * ARGV parameters for move-message-between-queues.lua
 * Redis Lua scripts use ARGV for non-key arguments.
 */
export type MoveMessageArgv = [
  messageId: string,
  destinationScore: number | string,
  deliveryStatus: DeviceMessageDeliveryStatus,
  deliveryQueueId: string,
  indexTtlSeconds: number | string,
];

/**
 * Result type for move-message-between-queues.lua
 *
 * Returns:
 * - 0 if the message was not in the source queue (no changes made)
 * - 1 if the message was successfully moved
 */
export type MoveMessageResult = 0 | 1;

