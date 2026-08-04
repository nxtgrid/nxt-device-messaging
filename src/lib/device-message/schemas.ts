/**
 * @fileoverview Zod schemas for the device-message aggregate (no TypeScript types).
 *
 * Inferred / lifecycle types live in `./types.ts`. Redis hash fields are camelCase;
 * key paths stay snake_case (ADR-003 / decisions-log 15b).
 */

import { z } from 'zod';

import {
  asZodEnum,
  ENQUEUEABLE_COMMAND_TYPES,
  GENERATE_TOKEN_TYPES,
} from './command-types.js';

/** I/O parent (LoRaWAN gateway / DCU / mesh hop) — D6. */
const relayNodeSchema = z.object({
  id: z.number().optional(),
  externalReference: z.string().optional(),
  snr: z.number().optional(),
  rssi: z.number().optional(),
}).strict();

const deviceSchema = z.object({
  type: z.literal('ELECTRICITY_METER'),
  externalReference: z.string().min(1),
  relayNode: relayNodeSchema.optional(),
}).strict();

export const setDatePayloadSchema = z.object({
  year: z.number().int(),
  month: z.number().int(),
  day: z.number().int(),
}).strict();

export const setTimePayloadSchema = z.object({
  hour: z.number().int(),
  minute: z.number().int(),
  second: z.number().int().optional(),
}).strict();

const requestDataSchema = z.object({
  token: z.string().optional(),
  payload: z.union([ setDatePayloadSchema, setTimePayloadSchema ]).optional(),
}).strict();

/** Electrical phase when the command is phase-specific. */
export const phaseSchema = z.enum([ 'A', 'B', 'C' ]);

/**
 * Fields supplied when creating / enqueuing a command (ADR-003 §2–§3).
 * `commandType` is closed by {@link ENQUEUEABLE_COMMAND_TYPES}; plugins declare a subset.
 */
export const createDeviceMessageSchema = z.object({
  commandType: z.enum(asZodEnum(ENQUEUEABLE_COMMAND_TYPES)),
  priority: z.number(),
  pluginId: z.string().min(1),
  requestData: requestDataSchema.optional(),
  phase: phaseSchema.optional(),
  networkId: z.number().nullable(),
  correlationId: z.string().min(1).optional(),
  device: deviceSchema,
}).strict();

/** `POST /message/cancel` body (ADR-003 §1). */
export const cancelOneBodySchema = z.object({
  correlationId: z.string().min(1),
}).strict();

/** `POST /messages/cancel` body (ADR-003 §1). */
export const cancelManyBodySchema = z.object({
  correlationIds: z.array(z.string().min(1)).min(1),
}).strict();

/**
 * `POST /token/generate` body (ADR-003 §1 / §3).
 * Single wire schema (includes `pluginId`); SPI omits routing at the call site.
 * `type` is closed by {@link GENERATE_TOKEN_TYPES}.
 */
export const generateTokenSchema = z.object({
  pluginId: z.string().min(1),
  type: z.enum(asZodEnum(GENERATE_TOKEN_TYPES)),
  issueDateString: z.string().min(1),
  device: z.object({
    externalReference: z.string().min(1),
    decoderKey: z.string().optional(),
  }).strict(),
  payload: z.object({
    kwh: z.number().optional(),
    powerLimit: z.number().optional(),
  }).strict().optional(),
}).strict();
