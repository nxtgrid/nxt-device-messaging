/**
 * @fileoverview Domain types for the device-message aggregate.
 *
 * Wire / shared vocabulary is owned by Zod in `./schemas.ts` and inferred here.
 * Prefer `z.infer<typeof …Schema>` over re-listing string unions.
 */

import { z } from 'zod';

import type { CommandType } from './command-types.js';
import {
  cancelMessageResultSchema,
  createDeviceMessageSchema,
  deliveryStatusSchema,
  deviceMessageResponseSchema,
  failureReasonSchema,
  generateTokenSchema,
  messageResponseSchema,
  messageResponseStatusSchema,
  phaseSchema,
  setDatePayloadSchema,
  setTimePayloadSchema,
  webhookMessagePayloadSchema,
} from './schemas.js';

export type {
  CommandType,
  ControlCommandType,
  EnqueueableCommandType,
  GenerateTokenType,
  PhaseSpecificReadCommandType,
  ReadCommandType,
  TokenCommandType,
  UnsolicitedCommandType,
  WriteCommandType,
} from './command-types.js';

/** Create DTO — inferred from {@link createDeviceMessageSchema}. */
export type CreateDeviceMessage = z.infer<typeof createDeviceMessageSchema>;

/**
 * `POST /token/generate` body (and token service request).
 * Inferred from {@link generateTokenSchema} (includes `pluginId`).
 */
export type GenerateTokenRequest = z.infer<typeof generateTokenSchema>;

/** `Omit` that distributes over unions (keeps `type` discrimination). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Plugin `token.generate` args — wire body without routing. */
export type GenerateTokenInput = DistributiveOmit<GenerateTokenRequest, 'pluginId'>;

export type PhaseEnum = z.infer<typeof phaseSchema>;
export type DeviceMessageDevice = CreateDeviceMessage['device'];
/** I/O parent on the wire (`device.relayNode`) — D6. */
export type RelayNodeInfo = NonNullable<DeviceMessageDevice['relayNode']>;
export type DeviceType = DeviceMessageDevice['type'];
export type SetDatePayload = z.infer<typeof setDatePayloadSchema>;
export type SetTimePayload = z.infer<typeof setTimePayloadSchema>;

/**
 * Opaque plugin id; core routes by this string.
 * Bundled ids are documented in ADR-003 §3 and declared on each plugin object — not listed here.
 */
export type PluginId = string;

/** Outcome of command execution on the device. */
export type MessageResponseStatus = z.infer<typeof messageResponseStatusSchema>;

/** Device response block on a message. */
export type MessageResponse = z.infer<typeof messageResponseSchema>;

/**
 * Delivery status — inferred from {@link deliveryStatusSchema}.
 *
 * Flow: QUEUED → SENT_TO_NS → DELIVERED_TO_NS → SENT_TO_DEVICE → DELIVERY_SUCCESSFUL
 *       ↓ (on failure at any step)
 *       TO_RETRY → QUEUED (retry) or DELIVERY_FAILED (max retries exceeded)
 */
export type DeviceMessageDeliveryStatus = z.infer<typeof deliveryStatusSchema>;

/**
 * Context provided when a delivery attempt fails.
 * Engine-only input to retryOrFail (includes `skipRetry`); not on the public wire.
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

/** Record of a delivery attempt failure, stored in failureHistory. */
export type FailureReason = z.infer<typeof failureReasonSchema>;

/**
 * Result of a cancel operation for a single correlation id.
 * Inferred from {@link cancelMessageResultSchema}.
 */
export type CancelMessageResult = z.infer<typeof cancelMessageResultSchema>;

/**
 * Command-API response body (enqueue/get) — inferred from
 * {@link deviceMessageResponseSchema}.
 */
export type DeviceMessageResponse = z.infer<typeof deviceMessageResponseSchema>;

/**
 * Adopter-facing message slice inside the outbound webhook event — inferred
 * from {@link webhookMessagePayloadSchema} (pick of the response schema).
 */
export type WebhookMessagePayload = z.infer<typeof webhookMessagePayloadSchema>;

/**
 * A message to be delivered to a remote device.
 *
 * Response-wire fields come from {@link DeviceMessageResponse}; `commandType` is the
 * full {@link CommandType} vocabulary (wider than the enqueue DTO) so unsolicited
 * ingress types can appear. `concurrencyRateLimitKey` is process-only.
 *
 * Lifecycle:
 * 1. Created via {@link CreateDeviceMessage} and enqueued
 * 2. Moves through delivery queues (NS → GW → Device)
 * 3. Receives response or times out
 * 4. On failure: retries with backoff or fails permanently
 */
export type DeviceMessage = Omit<DeviceMessageResponse, 'commandType'> & {
  /** Full vocabulary — enqueue wire is narrower ({@link EnqueueableCommandType}). */
  commandType: CommandType;
  /**
   * Redis concurrency admission track key, set at distribute claim.
   * Internal only — stripped before adopter-facing emit / GET.
   */
  concurrencyRateLimitKey?: string;
};

/**
 * Parsed event from network server webhook (almost a partial DeviceMessage).
 * Used by PUSH/PULL plugins to normalize vendor payloads into a common shape.
 */
export type ParsedIncomingEvent = {
  /** Optional for ACK events; may be unsolicited (`READ_REPORT` / `JOIN_NETWORK`). */
  commandType?: CommandType;
  /** External queue ID to correlate with stored message. */
  deliveryQueueId?: string;
  /** New delivery status based on event type. */
  deliveryStatus: DeviceMessageDeliveryStatus;
  /** Device information from the event. */
  device: DeviceMessageDevice;
  /** Response payload from device (for uplink events). */
  response?: MessageResponse;
  /** True if this is an unsolicited uplink from the device. */
  unsolicited?: boolean;
  failureContext?: FailureContext;
};
