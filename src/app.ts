import Fastify, { type FastifyInstance } from 'fastify';

import {
  ingressRoutes,
  type IngressRoutesOpts,
} from './http/ingress-routes.js';
import {
  messageRoutes,
  type MessageRoutesOpts,
} from './http/message-routes.js';
import {
  tokenRoutes,
  type TokenRoutesOpts,
} from './http/token-routes.js';

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
};

/**
 * Builds the HTTP application (ADR-001). Ops probes stay unauthenticated (ADR-005 §5).
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
  });

  app.get('/healthz', async () => {
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
