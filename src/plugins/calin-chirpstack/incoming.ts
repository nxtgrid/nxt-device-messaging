/**
 * @fileoverview `calin-chirpstack` incoming facet (Unit 10.5).
 *
 * Port of legacy `adapters/calin-lorawan/_incoming.service.ts`. Normalizes
 * ChirpStack HTTP-integration events into {@link ParsedIncomingEvent}.
 *
 * The sequence from ChirpStack is:
 * 1) Queueing with gRPC, returns queueItemId
 * 2) tx-ack event: Gateway confirms it sent it 'out' (with downlinkId and queueItemId)
 * 3) up event: Meter responds with data (with deduplicationId)
 * 4) ack event: Meter confirms it received (with queueItemId and deduplicationId)
 *
 * In reality, in ChirpStack 3 and 4 happen simultaneously and can be in reverse
 * order, which is why we have the correlator to match them, regardless of
 * incoming order.
 */

import type {
  DeviceMessageDevice,
  ParsedIncomingEvent,
  RelayNodeInfo,
} from '../../lib/device-message/types.js';
import type { DeviceMessagingPlugin } from '../plugin.interface.js';
import { selectGatewayWithBestSignal } from './lib/connectivity-helpers.js';
import { eventCorrelator } from './lib/correlate-request-response.js';
import { decodeResponseData } from './lib/decode-response-data.js';
import type {
  LorawanCalinAckEvent,
  LorawanCalinDownEvent,
  LorawanCalinJoinEvent,
  LorawanCalinUpEvent,
} from './lib/types.js';

/**
 * Build the PUSH incoming facet.
 *
 * @returns Incoming SPI with `handle` for ChirpStack webhook payloads
 */
export function createCalinChirpstackIncoming(): DeviceMessagingPlugin['incoming'] {
  const handle = (event: unknown): ParsedIncomingEvent | null => {
    if (!isRecord(event)) return null;

    const deviceInfo = event.deviceInfo;
    if (!isRecord(deviceInfo) || typeof deviceInfo.devEui !== 'string') {
      return null;
    }

    // ChirpStack DevEUI is 16 hex digits; meter serial is the trailing portion
    const meterExternalReference = deviceInfo.devEui.substring(5);
    if (!meterExternalReference) return null;

    /**
     * Downlink (tx-ack) event
     * Gateway confirmed the message was sent to meter
     */
    if ('downlinkId' in event) {
      return handleDown(event as LorawanCalinDownEvent, meterExternalReference);
    }

    /**
     * Ack uplink event
     * Meter acknowledged it received (and handled) the message
     */
    if ('acknowledged' in event) {
      return handleAck(event as LorawanCalinAckEvent, meterExternalReference);
    }

    /**
     * Join event
     * Meter joined the network
     * Meter was assigned a device address by the NS => no other data
     */
    if ('devAddr' in event && !('data' in event)) {
      return handleJoin(event as LorawanCalinJoinEvent, meterExternalReference);
    }

    /**
     * Uplink event
     * Following the meter ack, this contains the meter's response data
     */
    if ('data' in event) {
      return handleUp(event as LorawanCalinUpEvent, meterExternalReference);
    }

    /**
     * Other events
     * (no handler — drop)
     */
    return null;
  };

  return { handle };
}

function handleDown(
  event: LorawanCalinDownEvent,
  meterExternalReference: string,
): ParsedIncomingEvent {
  return {
    deliveryQueueId: event.queueItemId,
    deliveryStatus: 'SENT_TO_DEVICE',
    device: createDevice(meterExternalReference),
  };
}

function handleJoin(
  _event: LorawanCalinJoinEvent,
  meterExternalReference: string,
): ParsedIncomingEvent {
  return {
    deliveryStatus: 'DELIVERY_SUCCESSFUL',
    commandType: 'JOIN_NETWORK',
    response: {
      data: { networkJoined: true },
      status: 'EXECUTION_SUCCESS',
    },
    device: createDevice(meterExternalReference),
    unsolicited: true,
  };
}

function handleAck(
  event: LorawanCalinAckEvent,
  meterExternalReference: string,
): ParsedIncomingEvent | null {
  // If ack has failed, we failed to deliver to meter
  if (!event.acknowledged) {
    return {
      deliveryQueueId: event.queueItemId,
      deliveryStatus: 'DELIVERY_FAILED',
      device: createDevice(meterExternalReference),
      failureContext: {
        reason:
          'Downlink not acknowledged by device (may be offline, out of range, or missed RX window)',
      },
    };
  }

  // Send to correlator
  return eventCorrelator.onAckEvent(event);
}

function handleUp(
  event: LorawanCalinUpEvent,
  meterExternalReference: string,
): ParsedIncomingEvent | null {
  const decoded = decodeResponseData(event.data);
  if (!decoded) return null;

  const relayNode = event.rxInfo?.length
    ? selectGatewayWithBestSignal(event.rxInfo)
    : undefined;
  const device = createDevice(meterExternalReference, relayNode);

  // We immediately handle automatic events (unsolicited READ_REPORT)
  if (decoded.unsolicitedEventType === 'READ_REPORT') {
    return {
      deliveryStatus: 'DELIVERY_SUCCESSFUL',
      commandType: decoded.unsolicitedEventType,
      response: {
        data: decoded.data,
        status: decoded.status,
      },
      device,
      unsolicited: true,
    };
  }

  // Send to correlator
  return eventCorrelator.onUpEvent(event, decoded, device);
}

function createDevice(
  externalReference: string,
  relayNode?: RelayNodeInfo,
): DeviceMessageDevice {
  return {
    type: 'ELECTRICITY_METER',
    externalReference,
    ...(relayNode !== undefined ? { relayNode } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
