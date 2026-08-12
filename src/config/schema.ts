import { z } from 'zod';

/** Shared delivery-engine knobs; all optional with in-code defaults (ADR-002 §5 / §1). */
const deliverySchema = z.object({
  maxRetries: z.number().int().nonnegative().default(11),
  retryBaseDelayMs: z.number().int().positive().default(2000),
  retryBackoffMultiplier: z.number().min(1).default(2),
  retryMaxDelayMs: z.number().int().positive().default(3600000),
  messageTtlSeconds: z.number().int().positive().default(604800),
}).strict();

const engineSchema = z.object({
  /** When false, the delivery engine does not cycle (ingest/inspect only). Defaults on. */
  enabled: z.boolean().default(true),
}).strict();

/**
 * Outbound delivery-event webhook (ADR-003 §6).
 * Present ⇒ notify adopter; absent ⇒ no outbound callbacks.
 * Tuning defaults: 6 attempts, ~62s first→last, 10s POST timeout, 7d DLQ TTL.
 */
const eventWebhookSchema = z.object({
  url: z.url(),
  maxAttempts: z.number().int().positive().default(6),
  baseDelayMs: z.number().int().positive().default(2000),
  backoffMultiplier: z.number().min(1).default(2),
  maxDelayMs: z.number().int().positive().default(60_000),
  /** Per-POST AbortSignal deadline; keep under the drain claim lease (60s). */
  requestTimeoutMs: z.number().int().positive().default(10_000),
  deadLetterTtlSeconds: z.number().int().positive().default(604_800),
}).strict();

/**
 * Plugin entry as known to the core before plugin-contributed schemas are composed
 * (ADR-002 §3). Settings/tuning stay opaque here; Phase 2 tightens them per plugin.
 */
const pluginEntrySchema = z.object({
  id: z.string().min(1),
  settings: z.record(z.string(), z.unknown()).optional(),
  tuning: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const deviceMessagingConfigSchema = z.object({
  $schema: z.string().optional(),
  $schemaVersion: z.literal('1'),
  engine: engineSchema.default({ enabled: true }),
  delivery: deliverySchema.default({
    maxRetries: 11,
    retryBaseDelayMs: 2000,
    retryBackoffMultiplier: 2,
    retryMaxDelayMs: 3600000,
    messageTtlSeconds: 604800,
  }),
  eventWebhook: eventWebhookSchema.optional(),
  plugins: z.array(pluginEntrySchema).default([]),
}).strict();

export type DeviceMessagingConfig = z.infer<typeof deviceMessagingConfigSchema>;

/** Shared delivery-engine knobs (`config.delivery`) — retry / TTL only after D5. */
export type DeliveryConfig = DeviceMessagingConfig['delivery'];

/** Outbound event-webhook knobs when `eventWebhook` is configured. */
export type EventWebhookConfig = NonNullable<DeviceMessagingConfig['eventWebhook']>;
