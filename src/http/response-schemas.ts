/**
 * @fileoverview Shared HTTP response Zod schemas (OpenAPI + serializer).
 */

import { z } from 'zod';

/** One Zod field failure (validation 400s only). */
export const validationIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
}).strict();

/**
 * Error payload. Domain / auth errors omit `issues`; schema failures include them.
 */
export const errorBodySchema = z.object({
  error: z.string(),
  issues: z.array(validationIssueSchema).optional(),
}).strict();

/** `POST /token/generate` success body. */
export const generateTokenResponseSchema = z.object({
  token: z.string(),
}).strict();
