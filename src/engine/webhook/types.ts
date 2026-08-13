/**
 * @fileoverview Types for the outbound event-webhook messenger (ADR-003 §6).
 *
 * The HTTP body is {@link WebhookEvent}. Redis stores {@link WebhookStoredRecord}
 * (event + attempt metadata). Message slice is owned by device-message Zod
 * (`webhookMessagePayloadSchema`).
 */

import type { WebhookMessagePayload } from '../../lib/device-message/types.js';

export type { WebhookMessagePayload };

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
