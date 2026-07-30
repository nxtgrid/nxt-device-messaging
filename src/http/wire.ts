/**
 * @fileoverview HTTP wire shapes and temporary map to snake_case domain types.
 *
 * Wire is camelCase (ADR-003). Domain / Redis still use snake_case until an I3
 * (or dedicated) rename pass — then delete this module.
 */

import type {
  CreateDeviceMessage,
  DeviceMessage,
  DeviceMessageDevice,
  FailureReason,
  GatewayInfo,
} from '../lib/types.js';
import type { EnqueueBody } from './schemas.js';

export type WireGateway = {
  id?: number;
  externalReference?: string;
  snr?: number;
  rssi?: number;
};

export type WireDevice = {
  type: 'ELECTRICITY_METER';
  externalReference: string;
  gateway?: WireGateway;
};

export type WireFailureReason = {
  reason: string;
  errorCode?: number | string;
  details?: string;
  status: DeviceMessage['delivery_status'];
  timestamp: string;
  isFinal?: boolean;
};

/** CamelCase message as returned by the command API. */
export type WireDeviceMessage = {
  id: string;
  commandType: string;
  priority: number;
  pluginId: string;
  requestData?: EnqueueBody['requestData'];
  phase?: 'A' | 'B' | 'C';
  networkId: number | null;
  correlationId?: string;
  device: WireDevice;
  deliveryQueueId: string;
  deliveryStatus: DeviceMessage['delivery_status'];
  response?: DeviceMessage['response'];
  unsolicited?: boolean;
  retryCount?: number;
  failureHistory?: WireFailureReason[];
};

function gatewayToDomain(gateway: WireGateway | undefined): GatewayInfo | undefined {
  if (gateway === undefined) {
    return undefined;
  }
  return {
    ...(gateway.id !== undefined ? { id: gateway.id } : {}),
    ...(gateway.externalReference !== undefined
      ? { external_reference: gateway.externalReference }
      : {}),
    ...(gateway.snr !== undefined ? { snr: gateway.snr } : {}),
    ...(gateway.rssi !== undefined ? { rssi: gateway.rssi } : {}),
  };
}

function deviceToDomain(device: WireDevice): DeviceMessageDevice {
  return {
    type: device.type,
    external_reference: device.externalReference,
    ...(device.gateway !== undefined ? { gateway: gatewayToDomain(device.gateway) } : {}),
  };
}

function gatewayToWire(gateway: GatewayInfo | undefined): WireGateway | undefined {
  if (gateway === undefined) {
    return undefined;
  }
  return {
    ...(gateway.id !== undefined ? { id: gateway.id } : {}),
    ...(gateway.external_reference !== undefined
      ? { externalReference: gateway.external_reference }
      : {}),
    ...(gateway.snr !== undefined ? { snr: gateway.snr } : {}),
    ...(gateway.rssi !== undefined ? { rssi: gateway.rssi } : {}),
  };
}

function deviceToWire(device: DeviceMessageDevice): WireDevice {
  return {
    type: device.type,
    externalReference: device.external_reference,
    ...(device.gateway !== undefined ? { gateway: gatewayToWire(device.gateway) } : {}),
  };
}

function failureToWire(failure: FailureReason): WireFailureReason {
  return {
    reason: failure.reason,
    ...(failure.errorCode !== undefined ? { errorCode: failure.errorCode } : {}),
    ...(failure.details !== undefined ? { details: failure.details } : {}),
    status: failure.status,
    timestamp: failure.timestamp,
    ...(failure.isFinal !== undefined ? { isFinal: failure.isFinal } : {}),
  };
}

/**
 * Maps a validated enqueue body to the domain create shape (snake_case interim).
 */
export function enqueueBodyToDomain(
  body: EnqueueBody,
  correlationId: string,
): CreateDeviceMessage {
  return {
    command_type: body.commandType,
    priority: body.priority,
    pluginId: body.pluginId,
    ...(body.requestData !== undefined ? { request_data: body.requestData } : {}),
    ...(body.phase !== undefined ? { phase: body.phase } : {}),
    network_id: body.networkId,
    correlation_id: correlationId,
    device: deviceToDomain(body.device),
  };
}

/**
 * Maps a domain message to the camelCase wire response.
 */
export function deviceMessageToWire(message: DeviceMessage): WireDeviceMessage {
  return {
    id: message.id,
    commandType: message.command_type,
    priority: message.priority,
    pluginId: message.pluginId,
    ...(message.request_data !== undefined ? { requestData: message.request_data } : {}),
    ...(message.phase !== undefined ? { phase: message.phase } : {}),
    networkId: message.network_id,
    ...(message.correlation_id !== undefined
      ? { correlationId: message.correlation_id }
      : {}),
    device: deviceToWire(message.device),
    deliveryQueueId: message.delivery_queue_id,
    deliveryStatus: message.delivery_status,
    ...(message.response !== undefined ? { response: message.response } : {}),
    ...(message.unsolicited !== undefined ? { unsolicited: message.unsolicited } : {}),
    ...(message.retry_count !== undefined ? { retryCount: message.retry_count } : {}),
    ...(message.failure_history !== undefined
      ? { failureHistory: message.failure_history.map(failureToWire) }
      : {}),
  };
}
