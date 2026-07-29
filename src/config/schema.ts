import { z } from 'zod';

/** Shared delivery-engine knobs; all optional with in-code defaults (ADR-002 §5 / §1). */
const deliverySchema = z.object({
  maxRetries: z.number().int().nonnegative().default(11),
  retryBaseDelayMs: z.number().int().positive().default(2000),
  retryBackoffMultiplier: z.number().positive().default(2),
  retryMaxDelayMs: z.number().int().positive().default(3600000),
  messageTtlSeconds: z.number().int().positive().default(604800),
  /** Score timeout while awaiting NS acceptance (`queue_in_flight_to_ns`). */
  nsInFlightTimeoutMs: z.number().int().positive().default(20_000),
  /** Score timeout while awaiting gateway ACK (`queue_in_flight_to_gw`) — PUSH. */
  gwInFlightTimeoutMs: z.number().int().positive().default(900_000),
  /** Score timeout while awaiting device response (`queue_in_flight_to_device`) — PUSH. */
  deviceInFlightTimeoutMs: z.number().int().positive().default(12_000),
  /** Delay before first PULL status poll (`queue_awaiting_task:{pluginId}`). */
  initialPollDelayMs: z.number().int().positive().default(10_000),
}).strict();

const engineSchema = z.object({
  /** When false, the delivery engine does not cycle (ingest/inspect only). Defaults on. */
  enabled: z.boolean().default(true),
}).strict();

const resultWebhookSchema = z.object({
  url: z.url(),
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
    nsInFlightTimeoutMs: 20_000,
    gwInFlightTimeoutMs: 900_000,
    deviceInFlightTimeoutMs: 12_000,
    initialPollDelayMs: 10_000,
  }),
  resultWebhook: resultWebhookSchema.optional(),
  plugins: z.array(pluginEntrySchema).default([]),
}).strict();

export type DeviceMessagingConfig = z.infer<typeof deviceMessagingConfigSchema>;
