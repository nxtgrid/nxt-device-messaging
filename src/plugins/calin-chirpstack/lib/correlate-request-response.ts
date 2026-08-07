/**
 * @fileoverview In-memory correlator for LoRaWAN up + ack race.
 *
 * Port of legacy `adapters/calin-lorawan/lib/correlate-request-response.ts`.
 * ChirpStack may deliver the data uplink and the ACK in either order; we key
 * on `deduplicationId` and emit a combined {@link ParsedIncomingEvent} once
 * both halves arrive (or drop stale halves via GC).
 */

import type {
  DeviceMessageDevice,
  ParsedIncomingEvent,
} from '../../../lib/device-message/types.js';
import type {
  DecodedLorawanCalinEvent,
  LorawanCalinAckEvent,
  LorawanCalinUpEvent,
} from './types.js';

type CorrelationEntry = {
  queueItemId?: string;
  decoded?: DecodedLorawanCalinEvent;
  device?: DeviceMessageDevice;
  timestamp: number;
};

const pendingCorrelations = new Map<string, CorrelationEntry>();

/** Events should correlate within milliseconds; 10s TTL is generous. */
const CORRELATION_TTL_MS = 10_000;
const GC_INTERVAL_MS = 30_000;

/**
 * Correlate an ACK event with a pending (or future) uplink.
 *
 * @param event - ChirpStack ACK payload
 * @returns Combined event when the uplink already arrived; otherwise `null`
 */
function onAckEvent(event: LorawanCalinAckEvent): ParsedIncomingEvent | null {
  const existingEntry = pendingCorrelations.get(event.deduplicationId);

  if (existingEntry?.decoded) {
    pendingCorrelations.delete(event.deduplicationId);
    return {
      deliveryQueueId: event.queueItemId,
      deliveryStatus: 'DELIVERY_SUCCESSFUL',
      response: {
        status: existingEntry.decoded.status,
        data: existingEntry.decoded.data,
      },
      failureContext: existingEntry.decoded.failureContext,
      device: existingEntry.device!,
    };
  }

  pendingCorrelations.set(event.deduplicationId, {
    queueItemId: event.queueItemId,
    timestamp: Date.now(),
  });
  return null;
}

/**
 * Correlate a decoded uplink with a pending (or future) ACK.
 *
 * @param event - ChirpStack uplink payload
 * @param decoded - Decoded CALIN frame
 * @param device - Device (+ optional relayNode) for the combined event
 * @returns Combined event when the ACK already arrived; otherwise `null`
 */
function onUpEvent(
  event: LorawanCalinUpEvent,
  decoded: DecodedLorawanCalinEvent,
  device: DeviceMessageDevice,
): ParsedIncomingEvent | null {
  const existingEntry = pendingCorrelations.get(event.deduplicationId);

  if (existingEntry?.queueItemId) {
    pendingCorrelations.delete(event.deduplicationId);
    return {
      deliveryQueueId: existingEntry.queueItemId,
      deliveryStatus: 'DELIVERY_SUCCESSFUL',
      response: {
        status: decoded.status,
        data: decoded.data,
      },
      failureContext: decoded.failureContext,
      device,
    };
  }

  pendingCorrelations.set(event.deduplicationId, {
    timestamp: Date.now(),
    decoded,
    device,
  });
  return null;
}

/** Drop correlation entries older than {@link CORRELATION_TTL_MS}. */
function runGarbageCollection(): void {
  const now = Date.now();
  for (const [ deduplicationId, entry ] of pendingCorrelations.entries()) {
    if (now - entry.timestamp > CORRELATION_TTL_MS) {
      pendingCorrelations.delete(deduplicationId);
    }
  }
}

const gcTimer = setInterval(runGarbageCollection, GC_INTERVAL_MS);
// Do not keep the process alive solely for correlator GC.
gcTimer.unref();

/** In-memory up/ack correlator (process-local; not multi-instance safe). */
export const eventCorrelator = {
  onAckEvent,
  onUpEvent,
  runGarbageCollection,
  getPendingCount: (): number => pendingCorrelations.size,
  /** Test helper — clear all pending entries. */
  clear: (): void => {
    pendingCorrelations.clear();
  },
};
