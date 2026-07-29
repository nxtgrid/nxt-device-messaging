import { fromPairs, isNotNil, splitEvery } from 'ramda';
import type {
  CreateDeviceMessage,
  DeviceMessage,
  DeviceMessageDevice,
  DeviceMessageDeliveryStatus,
  PhaseEnum,
  FailureReason,
} from '../types.js';

/**
 * Convert a flat array [key1, val1, key2, val2, ...] to an object.
 * Used to parse HGETALL results from Redis Lua scripts / hashes.
 */
export const rawHashToObject = (raw: string[]): Record<string, string> => {
  const pairs = splitEvery(2, raw) as Array<[string, string]>;
  return fromPairs(pairs);
};

/**
 * Serialize a CreateDeviceMessage domain object for Redis hash storage.
 *
 * Complex objects (device, request_data) are JSON-stringified.
 *
 * `network_id` is omitted when null to avoid Redis coercing it into `""`
 * (which would then deserialize back as `NaN`).
 */
export const serializeCreateDeviceMessage = (dto: CreateDeviceMessage) => ({
  command_type: dto.command_type,
  priority: dto.priority,
  plugin_id: dto.pluginId,
  device: JSON.stringify(dto.device),

  ...(isNotNil(dto.network_id) && { network_id: dto.network_id }),
  ...(dto.correlation_id && { correlation_id: dto.correlation_id }),
  ...(dto.request_data && { request_data: JSON.stringify(dto.request_data) }),
  ...(dto.phase && { phase: dto.phase }),

  // Initial status when first enqueued
  delivery_status: 'QUEUED' as const satisfies DeviceMessageDeliveryStatus,
});

/**
 * Deserialize a Redis hash into a DeviceMessage object.
 *
 * Parses JSON fields and converts string numbers back to integers.
 *
 * NOTE: `delivery_queue_id` is required by the domain type, but it may be
 * absent for early pipeline stages. In that case we deserialize it as `''`
 * (truthy checks in cleanup/release paths treat this as "absent").
 */
export const deserializeMessage = (
  id: string,
  raw: Record<string, string>,
): DeviceMessage => {
  if (!raw.device) {
    throw new Error(`[REDIS] Message without device payload (messageId=${ id })`);
  }

  const device = JSON.parse(raw.device) as DeviceMessageDevice;

  return {
    id,
    command_type: raw.command_type,
    pluginId: raw.plugin_id,
    priority: parseInt(raw.priority),
    device,

    network_id: 'network_id' in raw ? parseInt(raw.network_id) : null,
    ...(raw.correlation_id ? { correlation_id: raw.correlation_id } : {}),

    ...(raw.request_data ? { request_data: JSON.parse(raw.request_data) } : {}),
    ...(raw.phase ? { phase: raw.phase as PhaseEnum } : {}),

    delivery_queue_id: raw.delivery_queue_id ?? '',
    delivery_status: raw.delivery_status as DeviceMessageDeliveryStatus,

    retry_count: parseInt(raw.retry_count ?? '0'),
    failure_history: raw.failure_history ? (JSON.parse(raw.failure_history) as FailureReason[]) : [],
  };
};

