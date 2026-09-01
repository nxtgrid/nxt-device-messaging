import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from '@fastify/type-provider-zod';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  ingressRoutes,
  type IngressRoutesOpts,
} from './http/ingress-routes.js';
import {
  messageRoutes,
  type MessageRoutesOpts,
} from './http/message-routes.js';
import { registerOpenApi } from './http/openapi.js';
import {
  provisioningRoutes,
  type ProvisioningRoutesOpts,
} from './http/provisioning-routes.js';
import {
  tokenRoutes,
  type TokenRoutesOpts,
} from './http/token-routes.js';
import { registerValidationErrorHandler } from './http/validation-errors.js';
import { logger } from './log.js';
import type { Metrics } from './metrics/index.js';

/**
 * HTTP composition deps. Command/ingress services are optional so probes
 * (e.g. `/healthz`) can boot without fakes. {@link Metrics} is required —
 * production `main.ts` and tests both pass an isolated registry.
 */
export type BuildAppOptions = {
  readonly metrics: Metrics;
  readonly apiKey?: string;
  readonly outgoingService?: MessageRoutesOpts['outgoingService'];
  readonly tokenService?: TokenRoutesOpts['tokenService'];
  readonly provisioningService?: ProvisioningRoutesOpts['provisioningService'];
  readonly incomingService?: IngressRoutesOpts['incomingService'];
  readonly registry?: IngressRoutesOpts['registry'];
};

const healthzResponseSchema = z.object({
  ok: z.literal(true),
});

/**
 * Builds the HTTP application (ADR-001). Ops probes stay unauthenticated (ADR-005 §5).
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerValidationErrorHandler(app);

  await registerOpenApi(app);

  await options.metrics.registerRoutes(app);

  app.get('/healthz', {
    schema: {
      tags: [ 'ops' ],
      response: {
        200: healthzResponseSchema,
      },
    },
  }, async () => {
    // TEMPORARY: diagnose App Platform bindables; remove after wiring is confirmed.
    logger.info({
      module: 'healthz',
      redisHost: process.env.REDIS_HOST ?? null,
      redisPort: process.env.REDIS_PORT ?? null,
      nxtStsUrl: process.env.NXT_STS_URL ?? null,
    }, 'health check');
    return { ok: true as const };
  });

  if (options.outgoingService) {
    await app.register(messageRoutes, {
      outgoingService: options.outgoingService,
      apiKey: options.apiKey,
    });
  }

  if (options.tokenService) {
    await app.register(tokenRoutes, {
      tokenService: options.tokenService,
      apiKey: options.apiKey,
    });
  }

  if (options.provisioningService) {
    await app.register(provisioningRoutes, {
      provisioningService: options.provisioningService,
      apiKey: options.apiKey,
    });
  }

  if (options.incomingService && options.registry) {
    await app.register(ingressRoutes, {
      incomingService: options.incomingService,
      registry: options.registry,
    });
  }

  return app;
}
