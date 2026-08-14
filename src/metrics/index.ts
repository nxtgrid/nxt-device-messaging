/**
 * @fileoverview Prometheus metrics (ADR-005 §5). One module: registry, series,
 * increment helpers, and the unauthenticated `GET /metrics` route.
 *
 * Dedicated {@link Registry} so tests do not share process-global counters.
 * Engine factories take {@link MetricsRecorder}; HTTP registers the same
 * {@link Metrics} instance so scrapes see in-process increments.
 * Queue-depth gauges are filled at scrape time from injected Redis + PULL ids.
 */

import type { FastifyInstance } from 'fastify';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

import { collectQueueDepths, type QueueDepthRedis } from './queue-depth.js';

export type { QueueDepth, QueueDepthRedis } from './queue-depth.js';

/** Terminal statuses exported on `device_messaging_messages_total`. */
export type MessageTerminalStatus =
  | 'DELIVERY_SUCCESSFUL'
  | 'DELIVERY_FAILED'
  | 'CANCELLED';

/** Outbound webhook drain outcomes on `device_messaging_webhook_events_total`. */
export type WebhookResult = 'posted' | 'retried' | 'dlq';

/** Increment API used by engine factories (no Fastify). */
export type MetricsRecorder = {
  recordMessageTerminal(status: MessageTerminalStatus, retryCount: number): void;
  recordWebhookResult(result: WebhookResult): void;
  recordIngressUnhandled(pluginId: string): void;
};

export type Metrics = MetricsRecorder & {
  readonly registerRoutes: (app: FastifyInstance) => Promise<void>;
};

/**
 * Wiring for {@link createMetrics}. Redis and PULL plugin ids come from outside
 * the metrics domain; scrape uses them to read queue depths.
 */
export type CreateMetricsOptions = {
  readonly redis: QueueDepthRedis;
  readonly pullPluginIds: readonly string[];
};

const RETRY_COUNT_BUCKETS = [ 0, 1, 2, 3, 4, 5, 6, 8, 11, 16 ];

/**
 * Builds an isolated metrics registry, series, and the `/metrics` route.
 */
export function createMetrics(options: CreateMetricsOptions): Metrics {
  const registry = new Registry();

  new Gauge({
    name: 'device_messaging_up',
    help: '1 while this process is exporting metrics',
    registers: [ registry ],
  }).set(1);

  const messagesTotal = new Counter({
    name: 'device_messaging_messages_total',
    help: 'Device messages that reached a terminal status',
    labelNames: [ 'status' ],
    registers: [ registry ],
  });

  const retryCount = new Histogram({
    name: 'device_messaging_retry_count',
    help: 'Retry count at terminal resolution',
    buckets: RETRY_COUNT_BUCKETS,
    registers: [ registry ],
  });

  const webhookEventsTotal = new Counter({
    name: 'device_messaging_webhook_events_total',
    help: 'Outbound webhook drain results',
    labelNames: [ 'result' ],
    registers: [ registry ],
  });

  const ingressUnhandledTotal = new Counter({
    name: 'device_messaging_ingress_unhandled_total',
    help: 'PUSH ingress events the plugin ignored (handle returned null)',
    labelNames: [ 'pluginId' ],
    registers: [ registry ],
  });

  const queueDepth = new Gauge({
    name: 'device_messaging_queue_depth',
    help: 'Redis sorted-set cardinality by queue key',
    labelNames: [ 'queue' ],
    registers: [ registry ],
  });

  function recordMessageTerminal(
    status: MessageTerminalStatus,
    retries: number,
  ): void {
    messagesTotal.inc({ status });
    retryCount.observe(retries);
  }

  function recordWebhookResult(result: WebhookResult): void {
    webhookEventsTotal.inc({ result });
  }

  function recordIngressUnhandled(pluginId: string): void {
    ingressUnhandledTotal.inc({ pluginId });
  }

  async function registerRoutes(app: FastifyInstance): Promise<void> {
    app.get('/metrics', {
      schema: {
        hide: true,
        tags: [ 'ops' ],
      },
    }, async (_request, reply) => {
      queueDepth.reset();
      const depths = await collectQueueDepths({
        redis: options.redis,
        pullPluginIds: options.pullPluginIds,
      });
      for (const row of depths) {
        queueDepth.set({ queue: row.queue }, row.depth);
      }
      return reply
        .header('Content-Type', registry.contentType)
        .send(await registry.metrics());
    });
  }

  return {
    recordMessageTerminal,
    recordWebhookResult,
    recordIngressUnhandled,
    registerRoutes,
  };
}
