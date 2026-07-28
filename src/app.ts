import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Builds the HTTP application shell (ADR-001). Domain routes land in Phase 3;
 * ops probes are outside the consumer contract (ADR-005 §5).
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
  });

  app.get('/healthz', async () => {
    return { ok: true as const };
  });

  return app;
}
