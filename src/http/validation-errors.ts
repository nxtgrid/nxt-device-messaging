/**
 * @fileoverview Map Zod/Fastify request validation failures to `{ error, issues }`.
 *
 * Domain 400s / 401 / 404 keep `{ error }` only. Schema failures add `issues`
 * with dotted field paths and Zod messages (Phase 3.3B).
 */

import { hasZodFastifySchemaValidationErrors } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';

/**
 * Registers an error handler that turns schema validation failures into
 * `{ error, issues: [{ path, message }] }` bodies.
 */
export function registerValidationErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, _request, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      const error = err.validationContext === 'params'
        ? 'Invalid path parameters'
        : 'Invalid request body';
      return reply.code(400).send({
        error,
        issues: err.validation.map(issue => ({
          path: dottedPath(issue.instancePath),
          message: issue.message ?? '',
        })),
      });
    }

    return reply.send(err);
  });
}

/** Fastify JSON-pointer `instancePath` (`/a/b`) → dotted `a.b`. Root → `""`. */
function dottedPath(instancePath: string): string {
  if (instancePath === '' || instancePath === '/') {
    return '';
  }
  return instancePath.replace(/^\//, '').replaceAll('/', '.');
}
