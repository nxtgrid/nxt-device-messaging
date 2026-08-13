/**
 * @fileoverview Map Zod/Fastify request validation failures to coarse error bodies.
 *
 * Richer validation payloads are Phase 3.3; keep today's `{ error: string }` until then.
 */

import { hasZodFastifySchemaValidationErrors } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';

/**
 * Registers an error handler that turns schema validation failures into coarse
 * `{ error: string }` bodies. Field-level Zod issues are deferred to Phase 3.3.
 */
export function registerCoarseValidationErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, _request, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      const error = err.validationContext === 'params'
        ? 'Invalid path parameters'
        : 'Invalid request body';
      return reply.code(400).send({ error });
    }

    return reply.send(err);
  });
}
