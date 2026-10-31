/**
 * @fileoverview Enqueue checks for `sparkmeter-sparknet-http`.
 *
 * The engine already rejects command types outside `supportedCommandTypes`.
 * These checks cover the basestation, `node_id`, and the point-4 body.
 */

import { isNil } from 'ramda';

import type {
  CreateDeviceMessage,
  PowerLimitPayload,
} from '../../../lib/device-message/types.js';

/** Largest `node_id` the spec allows (uint64). */
const UINT64_MAX = 18_446_744_073_709_551_615n;

/** Canonical base-10 integer: `0`, or digits without a leading zero. */
const BASE10_UINT_PATTERN = /^(0|[1-9][0-9]*)$/;

type RelayCommand = 'TURN_ON' | 'TURN_OFF';

type RequestPayload = NonNullable<CreateDeviceMessage['requestData']>['payload'];

/**
 * @param value - `device.externalReference`
 * @returns Whether `value` is a base-10 integer in the uint64 range
 */
function isBase10Uint64(value: string): boolean {
  if (!BASE10_UINT_PATTERN.test(value)) return false;
  return BigInt(value) <= UINT64_MAX;
}

/**
 * `{ powerLimit }` payload, including zero. A missing value is not a payload.
 */
export function isPowerLimitPayload(
  payload: RequestPayload,
): payload is PowerLimitPayload {
  return typeof payload === 'object'
    && payload !== null
    && 'powerLimit' in payload
    && !isNil(payload.powerLimit);
}

/**
 * Basestation id and `node_id` checks (plan 003 points 6 and 7).
 *
 * @returns An enqueue error detail, or `undefined` when the address is usable
 */
function validateAddress(
  create: CreateDeviceMessage,
  basestationIds: ReadonlySet<number>,
): string | undefined {
  const relayNodeId = create.device.relayNode?.id;
  if (isNil(relayNodeId)) {
    return 'device.relayNode.id is required';
  }
  if (!basestationIds.has(relayNodeId)) {
    return 'device.relayNode.id is not a configured basestation';
  }
  if (!isBase10Uint64(create.device.externalReference)) {
    return 'device.externalReference must be a base-10 uint64';
  }
  return undefined;
}

/**
 * `TURN_ON` / `TURN_OFF` carry `deviceState.powerLimit` and nothing else
 * the command would change (plan 003 point 4).
 */
function validateRelayCommand(
  commandType: RelayCommand,
  create: CreateDeviceMessage,
): string | undefined {
  const deviceState = create.requestData?.deviceState;
  if (create.requestData?.payload !== undefined) {
    return `${ commandType } rejects requestData.payload`;
  }
  if (!isNil(deviceState?.relay)) {
    return `${ commandType } rejects deviceState.relay`;
  }
  if (isNil(deviceState?.powerLimit)) {
    return `${ commandType } requires deviceState.powerLimit`;
  }
  return undefined;
}

/**
 * `SET_POWER_LIMIT` carries `{ powerLimit }` and the relay position to keep.
 */
function validateSetPowerLimit(create: CreateDeviceMessage): string | undefined {
  const deviceState = create.requestData?.deviceState;
  if (!isNil(deviceState?.powerLimit)) {
    return 'SET_POWER_LIMIT rejects deviceState.powerLimit';
  }
  if (!isPowerLimitPayload(create.requestData?.payload)) {
    return 'SET_POWER_LIMIT requires requestData.payload { powerLimit }';
  }
  if (isNil(deviceState?.relay)) {
    return 'SET_POWER_LIMIT requires deviceState.relay';
  }
  return undefined;
}

function validateCommand(create: CreateDeviceMessage): string | undefined {
  switch (create.commandType) {
    case 'TURN_ON':
    case 'TURN_OFF':
      return validateRelayCommand(create.commandType, create);
    case 'SET_POWER_LIMIT':
      return validateSetPowerLimit(create);
    default:
      return undefined;
  }
}

/**
 * Enqueue checks beyond `supportedCommandTypes`.
 *
 * @param create - Command body, after the core schema
 * @param basestationIds - `settings.basestations[].id` for this process
 * @returns An error detail string, or `undefined` when the command may queue
 */
export function validateSparkmeterEnqueue(
  create: CreateDeviceMessage,
  basestationIds: ReadonlySet<number>,
): string | undefined {
  return validateAddress(create, basestationIds) ?? validateCommand(create);
}
