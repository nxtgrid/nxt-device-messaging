/**
 * @fileoverview `calin-chirpstack` incoming facet.
 *
 * Normalizes ChirpStack HTTP-integration events into {@link ParsedIncomingEvent}.
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

import { createHash, timingSafeEqual } from 'node:crypto';

import type {
  DeviceMessageDevice,
  ParsedIncomingEvent,
  RelayNodeInfo,
} from '../../lib/device-message/types.js';
import { logger } from '../../log.js';
import type { IncomingHandleMeta, PushPlugin } from '../plugin.interface.js';
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

/** Optional inject for tests; production reads env in the plugin factory. */
export type CalinChirpstackIncomingOptions = {
  readonly ingressApiKey?: string;
};

/**
 * Build the PUSH incoming facet.
 *
 * `verifySignature` checks ChirpStack's `X-API-KEY` when
 * {@link CalinChirpstackIncomingOptions.ingressApiKey} is set. Unset → always
 * true (local). Ingress maps Fastify headers to lowercase keys.
 *
 * @param options - Optional ingress API key
 * @returns Incoming SPI with `handle` and `verifySignature`
 */
export function createCalinChirpstackIncoming(
  options: CalinChirpstackIncomingOptions = {},
): PushPlugin['incoming'] {
  const expectedKey = options.ingressApiKey;

  const verifySignature = (
    _rawBody: Buffer,
    headers: Record<string, string>,
  ): boolean => {
    if (expectedKey === undefined) return true;

    const received = headers['x-api-key'];
    if (secretEquals(expectedKey, received)) return true;

    logger.warn(
      { module: 'calin-chirpstack.incoming', headerPresent: received !== undefined },
      'ingress api key rejected',
    );
    return false;
  };

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
        if (!isTxackPayload(event)) return null;
        return handleDown(event, meterExternalReference);

      /**
       * Confirmed-downlink (n)ack
       * Meter acknowledged it received (and handled) the message
       */
      case 'ack':
        if (!isAckPayload(event)) return null;
        return handleAck(event, meterExternalReference);

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
        if (!isUpPayload(event)) return null;
        return handleUp(event, meterExternalReference);

      default:
        // Missing event, or status / log / location / integration / unknown
        return null;
    }
  };

  return { handle, verifySignature };
}

/** `txack` — `downlinkId` required; `queueItemId` optional. */
function isTxackPayload(event: Record<string, unknown>): event is LorawanCalinDownEvent {
  return typeof event.downlinkId === 'string';
}

/** `ack` — ids + boolean `acknowledged` (missing would look like nack). */
function isAckPayload(event: Record<string, unknown>): event is LorawanCalinAckEvent {
  return typeof event.queueItemId === 'string'
    && typeof event.deduplicationId === 'string'
    && typeof event.acknowledged === 'boolean';
}

/** `up` — `data` string before decode; `rxInfo` array (may be empty). */
function isUpPayload(event: Record<string, unknown>): event is LorawanCalinUpEvent {
  return typeof event.data === 'string' && Array.isArray(event.rxInfo);
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

/**
 * Constant-time compare of expected secret vs received header (SHA-256 then
 * `timingSafeEqual`). Missing header is treated as empty.
 *
 * @param expected - Configured ingress API key
 * @param received - `X-API-KEY` header or undefined
 */
function secretEquals(expected: string, received: string | undefined): boolean {
  const left = createHash('sha256').update(expected).digest();
  const right = createHash('sha256').update(received ?? '').digest();
  return timingSafeEqual(left, right);
}
