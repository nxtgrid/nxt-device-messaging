/**
 * @fileoverview PUSH pattern queue transitions (webhook-based, e.g. LoRaWAN/ChirpStack).
 *
 * PUSH pattern message flow after NS acceptance:
 *
 *   queue_in_flight_to_ns
 *         ↓ fromNsToRelayNode
 *   queue_in_flight_to_relay_node — awaiting relay-node ACK
 *         ↓ fromRelayNodeToDevice
 *   queue_in_flight_to_device — awaiting device response
 *         ↓ success or failure
 *   [cleanup] or [queue_awaiting_retry]
 */

import type { PluginTuning } from '../plugins/plugin.interface.js';
import { redisRepo } from './redis-repository/index.js';
import { redisKeys } from './redis-repository/keys.js';
import { _moveQueue, type QueueConfig, QUEUE_NS_KEY } from './queue-moving.js';

/** Relay-node queue: awaiting I/O parent ACK before end-device wait (D6). */
const CONFIG_QUEUE_RELAY_NODE: QueueConfig = {
  KEY: 'queue_in_flight_to_relay_node',
  MESSAGE_STATUS: 'DELIVERED_TO_NS',
};

/** Device queue: awaiting device response after transmission. */
const CONFIG_QUEUE_DEVICE: QueueConfig = {
  KEY: 'queue_in_flight_to_device',
  MESSAGE_STATUS: 'SENT_TO_DEVICE',
};

/** Exported key for the relay-node in-flight queue. */
export const QUEUE_RELAY_NODE_KEY = CONFIG_QUEUE_RELAY_NODE.KEY;

/** Exported key for Device queue. */
export const QUEUE_DEVICE_KEY = CONFIG_QUEUE_DEVICE.KEY;

/** PUSH pattern in-flight queue keys (for timeout scanning). */
export const PUSH_QUEUE_KEYS = [
  CONFIG_QUEUE_RELAY_NODE.KEY,
  CONFIG_QUEUE_DEVICE.KEY,
] as const;

/** Human-readable timeout reasons for each PUSH queue stage. */
export const PUSH_TIMEOUT_REASONS: Readonly<Record<string, string>> = {
  queue_in_flight_to_relay_node:
    'Timed out waiting for relay node to transmit message to device',
  queue_in_flight_to_device:
    'Timed out waiting for device response after transmission',
};

/**
 * PUSH pattern queue transitions.
 */
export const moveQueuePush = {
  /**
   * Move message from NS queue to relay-node queue after NS accepts the downlink.
   * Creates an index for looking up the message by external delivery ID.
   *
   * @param id - Message ULID
   * @param deliveryQueueId - External queue ID from the network server
   * @param tuning - Plugin stage timeouts (D5)
   * @param messageTtlSeconds - Shared message hash TTL
   */
  fromNsToRelayNode({
    id,
    deliveryQueueId,
    tuning,
    messageTtlSeconds,
  }: {
    id: string;
    deliveryQueueId: string;
    tuning: PluginTuning;
    messageTtlSeconds: number;
  }) {
    const timesOutAt = Date.now() + tuning.relayNodeInFlightTimeoutMs;
    return _moveQueue(
      id,
      QUEUE_NS_KEY,
      CONFIG_QUEUE_RELAY_NODE.KEY,
      timesOutAt,
      { deliveryStatus: CONFIG_QUEUE_RELAY_NODE.MESSAGE_STATUS, deliveryQueueId },
      messageTtlSeconds,
      redisKeys.indexExternalDeliveryId(deliveryQueueId),
    );
  },

  /**
   * Move message from relay-node queue to device queue after relay ACK.
   *
   * @param id - Message ULID
   * @param tuning - Plugin stage timeouts (D5)
   * @param messageTtlSeconds - Shared message hash TTL
   */
  fromRelayNodeToDevice({
    id,
    tuning,
    messageTtlSeconds,
  }: {
    id: string;
    tuning: PluginTuning;
    messageTtlSeconds: number;
  }) {
    const timesOutAt = Date.now() + tuning.deviceInFlightTimeoutMs;
    return _moveQueue(
      id,
      CONFIG_QUEUE_RELAY_NODE.KEY,
      CONFIG_QUEUE_DEVICE.KEY,
      timesOutAt,
      { deliveryStatus: CONFIG_QUEUE_DEVICE.MESSAGE_STATUS },
      messageTtlSeconds,
    );
  },

  /**
   * Extend the timeout for a message in the relay-node queue.
   * Used when the message is still queued remotely and we need to wait longer.
   *
   * Uses XX flag to only update if member exists, preventing a race condition
   * where an incoming webhook moves the message to the device queue between
   * the remote status check and this call.
   *
   * @param messageId - ULID of the message
   * @param tuning - Plugin stage timeouts (D5)
   */
  extendRelayNodeQueueTimeout(messageId: string, tuning: PluginTuning) {
    const newTimesOutAt = Date.now() + tuning.relayNodeInFlightTimeoutMs;
    return redisRepo.client.zadd(CONFIG_QUEUE_RELAY_NODE.KEY, 'XX', newTimesOutAt, messageId);
  },
};
