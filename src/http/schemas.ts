/**
 * @fileoverview Zod schemas for the thin command API (ADR-003).
 *
 * Wire JSON is camelCase. Plugin enablement is a single registry lookup in the
 * route handler — do not encode known plugin ids here.
 */

import { z } from 'zod';

const gatewaySchema = z.object({
  id: z.number().optional(),
  externalReference: z.string().optional(),
  snr: z.number().optional(),
  rssi: z.number().optional(),
}).strict();

const deviceSchema = z.object({
  type: z.literal('ELECTRICITY_METER'),
  externalReference: z.string().min(1),
  gateway: gatewaySchema.optional(),
}).strict();

const setDatePayloadSchema = z.object({
  year: z.number().int(),
  month: z.number().int(),
  day: z.number().int(),
}).strict();

const setTimePayloadSchema = z.object({
  hour: z.number().int(),
  minute: z.number().int(),
  second: z.number().int().optional(),
}).strict();

const requestDataSchema = z.object({
  token: z.string().optional(),
  payload: z.union([ setDatePayloadSchema, setTimePayloadSchema ]).optional(),
}).strict();

/**
 * `POST /message/enqueue` body — camelCase wire (ADR-003).
 */
export const enqueueBodySchema = z.object({
  commandType: z.string().min(1),
  priority: z.number(),
  pluginId: z.string().min(1),
  requestData: requestDataSchema.optional(),
  phase: z.enum([ 'A', 'B', 'C' ]).optional(),
  networkId: z.number().nullable(),
  correlationId: z.string().min(1).optional(),
  device: deviceSchema,
}).strict();

export type EnqueueBody = z.infer<typeof enqueueBodySchema>;

/** `GET /message/:correlationId` path params. */
export const correlationIdParamsSchema = z.object({
  correlationId: z.string().min(1),
}).strict();

export type CorrelationIdParams = z.infer<typeof correlationIdParamsSchema>;
