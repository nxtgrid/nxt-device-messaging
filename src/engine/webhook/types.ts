/**
 * @fileoverview Types for the outbound event-webhook messenger (ADR-003 §6).
 *
 * The HTTP body is {@link WebhookEvent}. Redis stores {@link WebhookStoredRecord}
 * (event + attempt metadata).
 */

import type {
  DeviceMessageDeliveryStatus,
  DeviceMessageDevice,
  FailureReason,
  MessageResponseStatus,
  PhaseEnum,
} from '../../lib/device-message/types.js';

/** Adopter-facing message slice inside the webhook event (no queue internals). */
export type WebhookMessagePayload = {
  readonly id?: string;
  readonly correlationId?: string;
  readonly commandType?: string;
  readonly deliveryStatus: DeviceMessageDeliveryStatus;
  readonly phase?: PhaseEnum;
  readonly device: DeviceMessageDevice;
  readonly response?: {
    readonly status: MessageResponseStatus;
    readonly data?: unknown;
  };
  readonly failureHistory?: readonly FailureReason[];
  readonly unsolicited?: boolean;
};

/**
 * HTTP POST body for one delivery-event notification.
 * `eventId` is reused across HTTP retries of the same notification.
 */
export type WebhookEvent = {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly pluginId: string;
  readonly message: WebhookMessagePayload;
};

/**
 * Redis payload under `webhook:payload:{eventId}` / `webhook:dlq:{eventId}`.
 * `attemptCount` = POSTs already completed (0 at enqueue; DLQ when ≥ maxAttempts).
 */
export type WebhookStoredRecord = {
  readonly event: WebhookEvent;
  readonly attemptCount: number;
  readonly lastError?: string;
};
