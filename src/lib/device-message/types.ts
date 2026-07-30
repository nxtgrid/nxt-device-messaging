/**
 * @fileoverview Domain types for the device-message aggregate.
 *
 * Create DTO is inferred from Zod in `./schemas.ts`. Lifecycle fields are TypeScript-only.
 */

import { z } from 'zod';

import {
  createDeviceMessageSchema,
  phaseSchema,
  setDatePayloadSchema,
  setTimePayloadSchema,
} from './schemas.js';

/** Create DTO — inferred from {@link createDeviceMessageSchema}. */
export type CreateDeviceMessage = z.infer<typeof createDeviceMessageSchema>;

export type PhaseEnum = z.infer<typeof phaseSchema>;
export type DeviceMessageDevice = CreateDeviceMessage['device'];
export type GatewayInfo = NonNullable<DeviceMessageDevice['gateway']>;
export type DeviceType = DeviceMessageDevice['type'];
export type SetDatePayload = z.infer<typeof setDatePayloadSchema>;
export type SetTimePayload = z.infer<typeof setTimePayloadSchema>;

/**
 * Opaque plugin id; core routes by this string.
 * Bundled ids are documented in ADR-003 §3 and declared on each plugin object — not listed here.
 */
export type PluginId = string;

/** Outcome of command execution on the device. */
export type MessageResponseStatus = 'EXECUTION_SUCCESS' | 'EXECUTION_FAILURE';

/**
 * Delivery status representing the message's position in the delivery pipeline.
 *
 * Flow: QUEUED → SENT_TO_NS → DELIVERED_TO_NS → SENT_TO_DEVICE → DELIVERY_SUCCESSFUL
 *       ↓ (on failure at any step)
 *       TO_RETRY → QUEUED (retry) or DELIVERY_FAILED (max retries exceeded)
 */
export type DeviceMessageDeliveryStatus =
  | 'QUEUED'
  | 'TO_RETRY'
  | 'SENT_TO_NS'
  | 'DELIVERED_TO_NS'
  | 'SENT_TO_DEVICE'
  | 'DELIVERY_SUCCESSFUL'
  | 'DELIVERY_FAILED';

/**
 * Context provided when a delivery attempt fails.
 * Used as input to retryOrFail and by network server adapters.
 */
export type FailureContext = {
  /** Human-readable description of what went wrong. */
  reason: string;
  /** gRPC or HTTP error code from the network server. */
  errorCode?: number | string;
  /** Additional error context (e.g., gRPC details, constraint names). */
  details?: string;
  /** If true, skip retries and fail immediately (unrecoverable error). */
  skipRetry?: boolean;
};

/**
 * Record of a delivery attempt failure, stored in failureHistory.
 */
export type FailureReason = {
  /** Human-readable description of what went wrong. */
  reason: string;
  /** gRPC or HTTP error code from the network server. */
  errorCode?: number | string;
  /** Additional error context (e.g., gRPC details, constraint names). */
  details?: string;
  /** Delivery status when the failure occurred. */
  status: DeviceMessageDeliveryStatus;
  /** ISO timestamp of the failure. */
  timestamp: string;
  /** Flags whether this is the final failure. */
  isFinal?: boolean;
};

/**
 * Result of a cancel operation for a single correlation id.
 * Returned by cancel-one / cancel-many Redis helpers.
 */
export type CancelMessageResult = {
  correlationId: string;
  /** CANCELLED: all messages removed. NOT_CANCELLABLE: at least one was in-flight. NOT_FOUND: no messages in Redis. */
  result: 'CANCELLED' | 'NOT_CANCELLABLE' | 'NOT_FOUND';
};

/**
 * A message to be delivered to a remote device.
 *
 * Lifecycle:
 * 1. Created via {@link CreateDeviceMessage} and enqueued
 * 2. Moves through delivery queues (NS → GW → Device)
 * 3. Receives response or times out
 * 4. On failure: retries with backoff or fails permanently
 */
export type DeviceMessage = CreateDeviceMessage & {
  /** Unique identifier (ULID). */
  id: string;
  /** External queue ID from network server (ChirpStack, Calin API, etc.). */
  deliveryQueueId: string;
  /** Current position in delivery pipeline. */
  deliveryStatus: DeviceMessageDeliveryStatus;
  /** Response data from the device (on success). */
  response?: {
    status: MessageResponseStatus;
    /** Opaque object payload; plugins own the concrete shape. */
    data?: Record<string, unknown>;
  };
  /** True if device sent this message without being asked. */
  unsolicited?: boolean;
  /** Number of delivery attempts (0 = first attempt). */
  retryCount?: number;
  /** History of failed delivery attempts. */
  failureHistory?: FailureReason[];
};

/**
 * Parsed event from network server webhook (almost a partial DeviceMessage).
 * Used by PUSH/PULL plugins to normalize vendor payloads into a common shape.
 */
export type ParsedIncomingEvent = {
  /** Opaque command type (optional for ACK events). */
  commandType?: string;
  /** External queue ID to correlate with stored message. */
  deliveryQueueId?: string;
  /** New delivery status based on event type. */
  deliveryStatus: DeviceMessageDeliveryStatus;
  /** Device information from the event. */
  device: DeviceMessageDevice;
  /** Response payload from device (for uplink events). */
  response?: {
    status: MessageResponseStatus;
    /** Opaque object payload; plugins own the concrete shape. */
    data?: Record<string, unknown>;
  };
  /** True if this is an unsolicited uplink from the device. */
  unsolicited?: boolean;
  failureContext?: FailureContext;
};
