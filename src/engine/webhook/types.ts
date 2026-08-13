/**
 * @fileoverview Types for the outbound event-webhook messenger (ADR-003 §6).
 *
 * The HTTP body is {@link WebhookEvent}. Redis stores {@link WebhookStoredRecord}
 * (event + attempt metadata). Message slice and event envelope are Zod-owned.
 */

import { z } from 'zod';

import type { WebhookMessagePayload } from '../../lib/device-message/types.js';
import { webhookEventSchema } from './event-schema.js';

export type { WebhookMessagePayload };

/** Outbound webhook POST body — inferred from {@link webhookEventSchema}. */
export type WebhookEvent = z.infer<typeof webhookEventSchema>;

/**
 * Redis payload under `webhook:payload:{eventId}` / `webhook:dlq:{eventId}`.
 * `attemptCount` = POSTs already completed (0 at enqueue; DLQ when ≥ maxAttempts).
 */
export type WebhookStoredRecord = {
  readonly event: WebhookEvent;
  readonly attemptCount: number;
  readonly lastError?: string;
};
