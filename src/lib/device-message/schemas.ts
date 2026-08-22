/**
 * @fileoverview Zod schemas for the device-message aggregate (no TypeScript types).
 *
 * Inferred / lifecycle types live in `./types.ts`. Redis hash fields are camelCase;
 * key paths stay snake_case (ADR-003 / decisions-log 15b).
 *
 * `.meta({ examples })` / `.describe()` feed OpenAPI (Phase 3.2); keep examples
 * informative so Swagger UI does not fall back to JSON-Schema integer extremes.
 */

import { z } from 'zod';

import {
  asZodEnum,
  COMMAND_TYPES,
  ENQUEUEABLE_COMMAND_TYPES,
} from './command-types.js';

/** I/O parent (LoRaWAN gateway / DCU / mesh hop) — D6. */
const relayNodeSchema = z.object({
  id: z.uint32().optional().meta({
    description: 'Vendor / NS identifier for the relay node',
    examples: [ 1 ],
  }),
  externalReference: z.string().optional().meta({
    examples: [ 'gw-01' ],
  }),
  snr: z.number().optional().meta({ examples: [ 7.5 ] }),
  rssi: z.number().optional().meta({ examples: [ -90 ] }),
}).strict();

const deviceSchema = z.object({
  type: z.literal('ELECTRICITY_METER'),
  externalReference: z.string().min(1).meta({
    description: 'Meter serial / external id',
    examples: [ 'METER-1001' ],
  }),
  relayNode: relayNodeSchema.optional(),
}).strict();

/**
 * SET_DATE payload. Year allows 2-digit or 4-digit forms used by plugins;
 * month/day are calendar bounds (plugins may still reject impossible dates).
 */
export const setDatePayloadSchema = z.object({
  year: z.number().int().min(0).max(9999).meta({
    description: 'Calendar year (2- or 4-digit, plugin-dependent)',
    examples: [ 2026 ],
  }),
  month: z.number().int().min(1).max(12).meta({ examples: [ 8 ] }),
  day: z.number().int().min(1).max(31).meta({ examples: [ 12 ] }),
}).strict().meta({
  examples: [ { year: 2026, month: 8, day: 12 } ],
});

/** SET_TIME payload. */
export const setTimePayloadSchema = z.object({
  hour: z.number().int().min(0).max(23).meta({ examples: [ 14 ] }),
  minute: z.number().int().min(0).max(59).meta({ examples: [ 30 ] }),
  second: z.number().int().min(0).max(59).optional().meta({ examples: [ 0 ] }),
}).strict().meta({
  examples: [ { hour: 14, minute: 30, second: 0 } ],
});

const requestDataSchema = z.object({
  token: z.string().optional().meta({
    description: 'Pre-minted token when the command carries one',
    examples: [ '12345678901234567890' ],
  }),
  payload: z.union([ setDatePayloadSchema, setTimePayloadSchema ]).optional(),
}).strict();

/** Electrical phases. {@link phaseSchema} and correlation-index lookups share this list. */
export const PHASES = [ 'A', 'B', 'C' ] as const;

/** Electrical phase when the command is phase-specific. */
export const phaseSchema = z.enum(PHASES);

/**
 * Fields supplied when creating / enqueuing a command (ADR-003 §2–§3).
 * `commandType` is closed by {@link ENQUEUEABLE_COMMAND_TYPES}; plugins declare a subset.
 */
export const createDeviceMessageSchema = z.object({
  commandType: z.enum(asZodEnum(ENQUEUEABLE_COMMAND_TYPES)).meta({
    examples: [ 'READ_CREDIT' ],
  }),
  /**
   * Delivery urgency within an initial queue. **Higher is more urgent**
   * (e.g. `100` is picked before `10`). Stored as Redis ZSET score `-priority`.
   */
  priority: z.number().meta({
    description: 'Higher is more urgent within an initial queue',
    examples: [ 10 ],
  }),
  pluginId: z.string().min(1).meta({
    description: 'Enabled plugin id (e.g. calin-chirpstack, calin-api-v2)',
    examples: [ 'calin-chirpstack' ],
  }),
  requestData: requestDataSchema.optional(),
  phase: phaseSchema.optional(),
  networkId: z.uint32().nullable().meta({
    description: 'Estate network id; null when not network-scoped',
    examples: [ 42 ],
  }),
  correlationId: z.string().min(1).optional().meta({
    description: 'Adopter correlation id (opaque string)',
    examples: [ 'corr-1001' ],
  }),
  device: deviceSchema,
}).strict().meta({
  examples: [ {
    commandType: 'READ_CREDIT',
    priority: 10,
    pluginId: 'calin-chirpstack',
    networkId: 42,
    correlationId: 'corr-1001',
    device: {
      type: 'ELECTRICITY_METER',
      externalReference: 'METER-1001',
    },
  } ],
});

/** `POST /message/cancel` body (ADR-003 §1). */
export const cancelOneBodySchema = z.object({
  correlationId: z.string().min(1).meta({ examples: [ 'corr-1001' ] }),
}).strict();

/** `POST /messages/cancel` body (ADR-003 §1). */
export const cancelManyBodySchema = z.object({
  correlationIds: z.array(z.string().min(1)).min(1).meta({
    examples: [ [ 'corr-1001', 'corr-1002' ] ],
  }),
}).strict();

/**
 * Cancel outcome for one correlation id (command API).
 * Infer {@link CancelMessageResult} from this — do not re-list the enum in types.
 */
export const cancelMessageResultSchema = z.object({
  correlationId: z.string(),
  /**
   * CANCELLED: all messages removed.
   * NOT_CANCELLABLE: at least one was in-flight.
   * NOT_FOUND: no messages in Redis.
   */
  result: z.enum([ 'CANCELLED', 'NOT_CANCELLABLE', 'NOT_FOUND' ]),
}).strict();

/**
 * Delivery pipeline status.
 * Infer {@link DeviceMessageDeliveryStatus} from this — do not re-list in types.
 *
 * Flow: QUEUED → SENT_TO_NS → DELIVERED_TO_NS → SENT_TO_DEVICE → DELIVERY_SUCCESSFUL
 *       ↓ (on failure at any step)
 *       TO_RETRY → QUEUED (retry) or DELIVERY_FAILED (max retries exceeded)
 */
export const deliveryStatusSchema = z.enum([
  'QUEUED',
  'TO_RETRY',
  'SENT_TO_NS',
  'DELIVERED_TO_NS',
  'SENT_TO_DEVICE',
  'DELIVERY_SUCCESSFUL',
  'DELIVERY_FAILED',
]);

/** Device execution outcome on a message response. */
export const messageResponseStatusSchema = z.enum([
  'EXECUTION_SUCCESS',
  'EXECUTION_FAILURE',
]);

export const messageResponseSchema = z.object({
  status: messageResponseStatusSchema,
  /** Opaque object payload; plugins own the concrete shape. */
  data: z.record(z.string(), z.unknown()).optional(),
}).strict();

/** One entry in `failureHistory` (stored / public wire). */
export const failureReasonSchema = z.object({
  reason: z.string(),
  errorCode: z.union([ z.number(), z.string() ]).optional(),
  details: z.string().optional(),
  status: deliveryStatusSchema,
  timestamp: z.string(),
  isFinal: z.boolean().optional(),
}).strict();

/**
 * Command-API response body (enqueue `201` / GET) — outgoing to the caller.
 * Wider `commandType` than create DTO; omits process-only fields
 * (`concurrencyRateLimitKey`). Domain {@link DeviceMessage} extends this.
 */
export const deviceMessageResponseSchema = z.object({
  id: z.string(),
  /** Full vocabulary (incl. unsolicited); enqueue DTO stays enqueueable-only. */
  commandType: z.enum(asZodEnum(COMMAND_TYPES)),
  priority: z.number(),
  pluginId: z.string(),
  requestData: requestDataSchema.optional(),
  phase: phaseSchema.optional(),
  networkId: z.uint32().nullable(),
  correlationId: z.string().optional(),
  device: deviceSchema,
  deliveryQueueId: z.string(),
  deliveryStatus: deliveryStatusSchema,
  response: messageResponseSchema.optional(),
  unsolicited: z.boolean().optional(),
  retryCount: z.number().optional(),
  failureHistory: z.array(failureReasonSchema).optional(),
}).strict();

/**
 * Outbound webhook `message` slice (ADR-003 §6) — pick from
 * {@link deviceMessageResponseSchema}, then optionalize everything except
 * `deliveryStatus` + `device`. Omits queue/create fields (`priority`,
 * `pluginId` on the event envelope, `requestData`, `deliveryQueueId`, …).
 */
export const webhookMessagePayloadSchema = deviceMessageResponseSchema
  .pick({
    id: true,
    correlationId: true,
    commandType: true,
    deliveryStatus: true,
    phase: true,
    device: true,
    response: true,
    failureHistory: true,
    unsolicited: true,
  })
  .partial({
    id: true,
    correlationId: true,
    commandType: true,
    phase: true,
    response: true,
    failureHistory: true,
    unsolicited: true,
  });

/** Device block shared by all `POST /token/generate` variants. */
const generateTokenDeviceSchema = z.object({
  externalReference: z.string().min(1).meta({ examples: [ 'METER-1001' ] }),
  decoderKey: z.string().optional().meta({ examples: [ 'deadbeef' ] }),
}).strict();

const generateTokenSharedFields = {
  pluginId: z.string().min(1).meta({ examples: [ 'nxt-sts' ] }),
  issueDateString: z.string().min(1).meta({
    description: 'Issue date (ISO date string)',
    examples: [ '2026-08-12' ],
  }),
  device: generateTokenDeviceSchema,
};

/**
 * `POST /token/generate` body (ADR-003 §1 / §3).
 * Discriminated on `type`: required payload fields are enforced at the wire
 * (includes `pluginId`; SPI omits routing at the call site).
 */
export const generateTokenSchema = z.discriminatedUnion('type', [
  z.object({
    ...generateTokenSharedFields,
    type: z.literal('TOP_UP_KWH'),
    payload: z.object({
      kwh: z.number().meta({ examples: [ 10 ] }),
    }).strict(),
  }).strict().meta({
    examples: [ {
      type: 'TOP_UP_KWH',
      pluginId: 'nxt-sts',
      issueDateString: '2026-08-12',
      device: { externalReference: 'METER-1001', decoderKey: 'deadbeef' },
      payload: { kwh: 10 },
    } ],
  }),
  z.object({
    ...generateTokenSharedFields,
    type: z.literal('SET_POWER_LIMIT'),
    payload: z.object({
      powerLimit: z.number().meta({ examples: [ 1200 ] }),
    }).strict(),
  }).strict(),
  z.object({
    ...generateTokenSharedFields,
    type: z.literal('CLEAR_TAMPER'),
  }).strict(),
  z.object({
    ...generateTokenSharedFields,
    type: z.literal('CLEAR_CREDIT'),
  }).strict(),
]);
