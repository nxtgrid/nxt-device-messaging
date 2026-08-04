/**
 * @fileoverview Tiny HTTP path-param schemas for message routes (transport only).
 *
 * Domain create body: `lib/device-message/schemas.ts`.
 */

import { z } from 'zod';

/** `GET /message/:correlationId` path params. */
export const correlationIdParamsSchema = z.object({
  correlationId: z.string().min(1),
}).strict();

export type CorrelationIdParams = z.infer<typeof correlationIdParamsSchema>;

/** `POST /ingress/:pluginId` path params. */
export const pluginIdParamsSchema = z.object({
  pluginId: z.string().min(1),
}).strict();

export type PluginIdParams = z.infer<typeof pluginIdParamsSchema>;
