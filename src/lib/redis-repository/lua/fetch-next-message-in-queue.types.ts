import { type DeviceMessageDeliveryStatus } from '../../device-message/types.js';

/**
 * KEYS parameters for fetch-next-message-in-queue.lua
 * Redis Lua scripts use KEYS for key names (required for cluster mode).
 */
export type FetchNextMessageKeys = [
  sourceQueue: string,
  destinationQueue: string,
  listOfQueuesToDistributeFrom: string,
  concurrencySet: string,
];

/**
 * ARGV parameters for fetch-next-message-in-queue.lua
 * Redis Lua scripts use ARGV for non-key arguments.
 */
export type FetchNextMessageArgv = [
  timeoutAt: number | string,
  newStatus: DeviceMessageDeliveryStatus,
  maxInFlight: number | string,
];

/**
 * Result type for fetch-next-message-in-queue.lua
 *
 * This Lua script atomically fetches the highest priority message from a source queue,
 * moves it to a destination queue, updates its status, and returns the message data.
 * All operations happen in a single Redis roundtrip to prevent race conditions.
 *
 * Returns:
 * - null if no messages available in source queue
 * - [messageId, flattenedMessageFields] if message found
 *   where flattenedMessageFields is a flat array: [field1, value1, field2, value2, ...]
 */
export type FetchNextMessageResult = [
  messageId: string,
  messageFields: string[],
] | null;

