/**
 * @fileoverview Zod schema for the outbound webhook HTTP body (ADR-003 §6).
 *
 * OpenAPI documents this under `webhooks` (not an inbound `paths` entry).
 */

import { z } from 'zod';

import { webhookMessagePayloadSchema } from '../../lib/device-message/schemas.js';

/**
 * POST body this service sends to `eventWebhook.url`.
 * Infer {@link WebhookEvent} from this — do not re-list fields in types.
 */
export const webhookEventSchema = z.object({
  eventId: z.string().meta({
    description: 'ULID for this notification; reused across HTTP retries',
    examples: [ '01ARZ3NDEKTSV4RRFFQ69G5FAV' ],
  }),
  occurredAt: z.string().meta({
    description: 'ISO-8601 timestamp when the event was built',
    examples: [ '2026-08-13T10:00:00.000Z' ],
  }),
  pluginId: z.string().meta({
    description: 'Plugin that produced the delivery event',
    examples: [ 'calin-chirpstack' ],
  }),
  message: webhookMessagePayloadSchema,
}).strict().meta({
  id: 'WebhookEvent',
  description: 'Outbound delivery-event notification (this service → adopter). Not an inbound route.',
});
