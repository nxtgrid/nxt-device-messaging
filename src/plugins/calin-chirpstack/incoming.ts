/**
 * @fileoverview `calin-chirpstack` incoming facet (Unit 10.5).
 *
 * Port of legacy `adapters/calin-lorawan/_incoming.service.ts`. Normalizes
 * ChirpStack HTTP-integration events into {@link ParsedIncomingEvent}.
 *
 * Routes on ChirpStack's `?event=` query param (HTTP integration contract), not
 * body-field heuristics. Handled: `txack` / `ack` / `join` / `up`. Missing or
 * other events (`status`, `log`, `location`, `integration`, …) → `null`.
 *
 * The sequence from ChirpStack is:
 * 1) Queueing with gRPC, returns queueItemId
 * 2) txack: Gateway confirms it sent it 'out' (with downlinkId and queueItemId)
 * 3) up: Meter responds with data (with deduplicationId)
 * 4) ack: Meter confirms it received (with queueItemId and deduplicationId)
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
import type { DeviceMessagingPlugin, IncomingHandleMeta } from '../plugin.interface.js';
import { selectGatewayWithBestSignal } from './lib/connectivity-helpers.js';
import { eventCorrelator } from './lib/correlate-request-response.js';
import { decodeResponseData } from './lib/decode-response-data.js';
import type {
  LorawanCalinAckEvent,
  LorawanCalinDownEvent,
  LorawanCalinJoinEvent,
  LorawanCalinUpEvent,
} from './lib/types.js';

/** ChirpStack DevEUI length in hex digits (matches outgoing `padStart(16, '0')`). */
const DEV_EUI_LENGTH = 16;

/**
 * Leading DevEUI digits that are not part of the meter serial.
 * 11-digit meter refs → 5 zero-pad digits; inverse of outgoing padStart.
 */
const METER_REFERENCE_OFFSET = 5;

/**
 * Build the PUSH incoming facet.
 *
 * @returns Incoming SPI with `handle` for ChirpStack webhook payloads
 */
export function createCalinChirpstackIncoming(): DeviceMessagingPlugin['incoming'] {
  const handle = (
    event: unknown,
    meta?: IncomingHandleMeta,
  ): ParsedIncomingEvent | null => {
    if (!isRecord(event)) return null;

    const deviceInfo = event.deviceInfo;
    if (!isRecord(deviceInfo) || typeof deviceInfo.devEui !== 'string') {
      return null;
    }

    const { devEui } = deviceInfo;
    if (devEui.length !== DEV_EUI_LENGTH) return null;

    const meterExternalReference = devEui.substring(METER_REFERENCE_OFFSET);
    if (!meterExternalReference) return null;

    switch (meta?.query.event) {
      /**
       * Downlink (txack)
       * Gateway confirmed the message was radiated to the meter
       */
      case 'txack':
        return handleDown(event as LorawanCalinDownEvent, meterExternalReference);

      /**
       * Confirmed-downlink (n)ack
       * Meter acknowledged it received (and handled) the message
       */
      case 'ack':
        return handleAck(event as LorawanCalinAckEvent, meterExternalReference);

      /**
       * Join
       * Meter joined the network; NS assigned a device address — no uplink payload
       */
      case 'join':
        return handleJoin(event as LorawanCalinJoinEvent, meterExternalReference);

      /**
       * Uplink
       * Meter response data (may race with ack — correlator matches either order)
       */
      case 'up':
        return handleUp(event as LorawanCalinUpEvent, meterExternalReference);

      default:
        // Missing event, or status / log / location / integration / unknown
        return null;
    }
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
