import { describe, expect, it } from 'vitest';

import { buildApp } from '#src/app.js';
import { createMetrics } from '#src/metrics/index.js';
import { createFakeQueueDepthRedis } from '../helpers/fake-queue-depth-redis.js';

function createTestMetrics(
  redis = createFakeQueueDepthRedis(),
  pullPluginIds: readonly string[] = [],
) {
  return createMetrics({ redis, pullPluginIds });
}

async function scrape(
  metrics = createTestMetrics(),
): Promise<string> {
  const app = await buildApp({ metrics });
  const response = await app.inject({ method: 'GET', url: '/metrics' });
  await app.close();
  expect(response.statusCode).toBe(200);
  return response.body;
}

describe('GET /metrics', () => {
  it('serves Prometheus text without auth', async () => {
    const app = await buildApp({ metrics: createTestMetrics() });

    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/plain/);
    expect(response.body).toContain('device_messaging_up');
    expect(response.body).toMatch(/device_messaging_up(?:\{[^}]*\})? 1/);

    const healthz = await app.inject({ method: 'GET', url: '/healthz' });
    expect(healthz.statusCode).toBe(200);

    await app.close();
  });

  it('is omitted from the OpenAPI document (Prometheus text, not the command API)', async () => {
    const app = await buildApp({ metrics: createTestMetrics() });

    const doc = (await app.inject({ method: 'GET', url: '/v3/api-docs' })).json();
    expect(doc.paths['/metrics']).toBeUndefined();
    expect(doc.paths['/healthz'].get).toBeDefined();

    await app.close();
  });

  it('exposes in-process counters and the retry histogram after increments', async () => {
    const metrics = createTestMetrics();
    metrics.recordMessageTerminal('DELIVERY_SUCCESSFUL', 0);
    metrics.recordMessageTerminal('DELIVERY_FAILED', 2);
    metrics.recordMessageTerminal('CANCELLED', 1);
    metrics.recordWebhookResult('posted');
    metrics.recordWebhookResult('retried');
    metrics.recordWebhookResult('dlq');
    metrics.recordIngressUnhandled('calin-chirpstack');

    const body = await scrape(metrics);

    expect(body).toContain('device_messaging_messages_total{status="DELIVERY_SUCCESSFUL"} 1');
    expect(body).toContain('device_messaging_messages_total{status="DELIVERY_FAILED"} 1');
    expect(body).toContain('device_messaging_messages_total{status="CANCELLED"} 1');
    expect(body).toContain('device_messaging_webhook_events_total{result="posted"} 1');
    expect(body).toContain('device_messaging_webhook_events_total{result="retried"} 1');
    expect(body).toContain('device_messaging_webhook_events_total{result="dlq"} 1');
    expect(body).toContain(
      'device_messaging_ingress_unhandled_total{pluginId="calin-chirpstack"} 1',
    );
    expect(body).toMatch(/device_messaging_retry_count_count \d/);
    expect(body).toContain('device_messaging_retry_count_sum 3');
  });

  it('does not leak increments across isolated registries', async () => {
    const first = createTestMetrics();
    first.recordMessageTerminal('DELIVERY_FAILED', 0);
    const secondBody = await scrape(createTestMetrics());
    expect(secondBody).not.toContain('status="DELIVERY_FAILED"');
  });

  it('exports queue-depth gauges from Redis at scrape time', async () => {
    const body = await scrape(createTestMetrics(createFakeQueueDepthRedis({
      members: [ 'queue:stub-push:network:42' ],
      cards: {
        queue_in_flight_to_ns: 2,
        'queue:stub-push:network:42': 7,
      },
    })));

    expect(body).toContain('device_messaging_queue_depth{queue="queue_in_flight_to_ns"} 2');
    expect(body).toContain(
      'device_messaging_queue_depth{queue="queue:stub-push:network:42"} 7',
    );
  });

  it('drops stale initial-queue labels between scrapes', async () => {
    const state = {
      members: [ 'queue:stub-push:network:42' ],
      cards: { 'queue:stub-push:network:42': 7 },
    };
    const metrics = createTestMetrics(createFakeQueueDepthRedis(state));

    const first = await scrape(metrics);
    expect(first).toContain(
      'device_messaging_queue_depth{queue="queue:stub-push:network:42"} 7',
    );

    state.members = [];
    const second = await scrape(metrics);
    expect(second).not.toContain('queue:stub-push:network:42');
  });
});
