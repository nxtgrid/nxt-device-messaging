/**
 * @fileoverview Prometheus metrics (ADR-005 §5). One module: registry, series, and
 * the unauthenticated `GET /metrics` route. Engine call sites will increment here
 * later; scrapers only hit this HTTP handler.
 *
 * Dedicated {@link Registry} so tests do not share process-global counters.
 */

import type { FastifyInstance } from 'fastify';
import { Gauge, Registry } from 'prom-client';

export type Metrics = {
  readonly registerRoutes: (app: FastifyInstance) => Promise<void>;
};

/**
 * Builds an isolated metrics registry and the `/metrics` route.
 */
export function createMetrics(): Metrics {
  const registry = new Registry();

  new Gauge({
    name: 'device_messaging_up',
    help: '1 while this process is exporting metrics',
    registers: [ registry ],
  }).set(1);

  async function registerRoutes(app: FastifyInstance): Promise<void> {
    app.get('/metrics', {
      schema: {
        hide: true,
        tags: [ 'ops' ],
      },
    }, async (_request, reply) => {
      return reply
        .header('Content-Type', registry.contentType)
        .send(await registry.metrics());
    });
  }

  return { registerRoutes };
}
