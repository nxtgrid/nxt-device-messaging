import { fromPairs, isNotNil, splitEvery } from 'ramda';
import type {
  CommandType,
  CreateDeviceMessage,
  DeviceMessage,
  DeviceMessageDevice,
  DeviceMessageDeliveryStatus,
  PhaseEnum,
  FailureReason,
} from '../device-message/types.js';

/**
 * Convert a flat array [key1, val1, key2, val2, ...] to an object.
 * Used to parse HGETALL results from Redis Lua scripts / hashes.
 *
 * @param raw - Flat key/value string array from Redis
 */
export const rawHashToObject = (raw: string[]): Record<string, string> => {
  const pairs = splitEvery(2, raw) as Array<[string, string]>;
  return fromPairs(pairs);
};

/**
 * Serialize a CreateDeviceMessage domain object for Redis hash storage.
 *
 * Complex objects (device, requestData) are JSON-stringified.
 *
 * `networkId` is omitted when null to avoid Redis coercing it into `""`
 * (which would then deserialize back as `NaN`).
 *
 * @param dto - Create DTO to store
 */
export const serializeCreateDeviceMessage = (dto: CreateDeviceMessage) => ({
  commandType: dto.commandType,
  priority: dto.priority,
  pluginId: dto.pluginId,
  device: JSON.stringify(dto.device),

  ...(isNotNil(dto.networkId) && { networkId: dto.networkId }),
  ...(dto.correlationId && { correlationId: dto.correlationId }),
  ...(dto.requestData && { requestData: JSON.stringify(dto.requestData) }),
  ...(dto.phase && { phase: dto.phase }),

  // Initial status when first enqueued
  deliveryStatus: 'QUEUED' as const satisfies DeviceMessageDeliveryStatus,
});

/**
 * Deserialize a Redis hash into a DeviceMessage object.
 *
 * Parses JSON fields and converts string numbers back to integers.
 *
 * NOTE: `deliveryQueueId` is required by the domain type, but it may be
 * absent for early pipeline stages. In that case we deserialize it as `''`
 * (truthy checks in cleanup/release paths treat this as "absent").
 *
 * @param id - Message ULID (Redis hash key suffix)
 * @param raw - Hash field map from Redis
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
    commandType: raw.commandType as CommandType,
    pluginId: raw.pluginId,
    priority: parseInt(raw.priority),
    device,

    networkId: 'networkId' in raw ? parseInt(raw.networkId) : null,
    ...(raw.correlationId ? { correlationId: raw.correlationId } : {}),

    ...(raw.requestData
      ? { requestData: JSON.parse(raw.requestData) as NonNullable<CreateDeviceMessage['requestData']> }
      : {}
    ),
    ...(raw.phase ? { phase: raw.phase as PhaseEnum } : {}),

    deliveryQueueId: raw.deliveryQueueId ?? '',
    deliveryStatus: raw.deliveryStatus as DeviceMessageDeliveryStatus,

    retryCount: parseInt(raw.retryCount ?? '0'),
    failureHistory: raw.failureHistory ? (JSON.parse(raw.failureHistory) as FailureReason[]) : [],
  };
};
