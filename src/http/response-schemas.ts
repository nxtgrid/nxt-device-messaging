/**
 * @fileoverview Shared HTTP response Zod schemas (OpenAPI + serializer).
 *
 * Coarse error bodies stay until Phase 3.3 auth / HTTP polish.
 */

import { z } from 'zod';

/** Command / domain error payload. */
export const errorBodySchema = z.object({
  error: z.string(),
}).strict();

/** `POST /token/generate` success body. */
export const generateTokenResponseSchema = z.object({
  token: z.string(),
}).strict();
