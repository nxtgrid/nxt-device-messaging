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
  tokenRoutes,
  type TokenRoutesOpts,
} from './http/token-routes.js';
import { registerValidationErrorHandler } from './http/validation-errors.js';
import { createMetrics, type Metrics } from './metrics/index.js';

/**
 * HTTP composition deps. Services are optional so probes (e.g. `/healthz`) can
 * boot without fakes; each route plugin registers only when its deps are present.
 * Production `main.ts` supplies all of them.
 */
export type BuildAppOptions = {
  readonly apiKey?: string;
  readonly outgoingService?: MessageRoutesOpts['outgoingService'];
  readonly tokenService?: TokenRoutesOpts['tokenService'];
  readonly incomingService?: IngressRoutesOpts['incomingService'];
  readonly registry?: IngressRoutesOpts['registry'];
  /** Isolated Prometheus registry; default {@link createMetrics} when omitted. */
  readonly metrics?: Metrics;
};

const healthzResponseSchema = z.object({
  ok: z.literal(true),
});

/**
 * Builds the HTTP application (ADR-001). Ops probes stay unauthenticated (ADR-005 §5).
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerValidationErrorHandler(app);

  await registerOpenApi(app);

  const metrics = options.metrics ?? createMetrics();
  await metrics.registerRoutes(app);

  app.get('/healthz', {
    schema: {
      tags: [ 'ops' ],
      response: {
        200: healthzResponseSchema,
      },
    },
  }, async () => {
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

  if (options.incomingService && options.registry) {
    await app.register(ingressRoutes, {
      incomingService: options.incomingService,
      registry: options.registry,
    });
  }

  return app;
}
