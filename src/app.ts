import Fastify, { type FastifyInstance } from 'fastify';

import {
  ingressRoutes,
  type IngressRoutesOpts,
} from './http/ingress-routes.js';
import {
  messageRoutes,
  type MessageRoutesOpts,
} from './http/message-routes.js';

/** Composition-root deps for HTTP — command routes + vendor ingress. */
export type BuildAppOptions = MessageRoutesOpts & IngressRoutesOpts;

/**
 * Builds the HTTP application (ADR-001). Ops probes stay unauthenticated (ADR-005 §5).
 * Callers (composition root / tests) supply outgoing, incoming, and registry.
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
  });

  app.get('/healthz', async () => {
    return { ok: true as const };
  });

  await app.register(messageRoutes, {
    outgoing: options.outgoing,
    apiKey: options.apiKey,
  });

  await app.register(ingressRoutes, {
    incoming: options.incoming,
    registry: options.registry,
  });

  return app;
}
