import Fastify, { type FastifyInstance } from 'fastify';

import {
  messageRoutes,
  type MessageRoutesOpts,
} from './http/message-routes.js';

/** Same surface as the message plugin — `buildApp` does not invent defaults. */
export type BuildAppOptions = MessageRoutesOpts;

/**
 * Builds the HTTP application (ADR-001). Ops probes stay unauthenticated (ADR-005 §5).
 * Callers (composition root / tests) supply {@link MessageRoutesOpts.outgoing}.
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
  });

  app.get('/healthz', async () => {
    return { ok: true as const };
  });

  await app.register(messageRoutes, options);

  return app;
}
