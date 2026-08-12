/**
 * @fileoverview OpenAPI document + Swagger UI (Phase 3.2; ADR-001 §3 / ADR-003 §7).
 *
 * Paths mirror `nxt-sts`: machine JSON at `/v3/api-docs`, UI at `/swagger`.
 * Docs endpoints stay unauthenticated; command routes keep Bearer separately.
 */

import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
} from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';

import packageJson from '../../package.json' with { type: 'json' };

/**
 * Registers `@fastify/swagger`, Swagger UI, and the STS-mirrored JSON route.
 * Call before application routes so transforms apply; the document is built
 * dynamically when `/v3/api-docs` is requested.
 */
export async function registerOpenApi(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'NXT Device Messaging',
        description:
          'Reliable, prioritized, retrying command delivery to addressable field devices',
        version: packageJson.version,
      },
    },
    transform: jsonSchemaTransform,
  });

  await app.register(swaggerUi, {
    routePrefix: '/swagger',
  });

  app.get('/v3/api-docs', {
    schema: { hide: true },
  }, async () => app.swagger());
}
