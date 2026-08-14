import { describe, expect, it } from 'vitest';

import { buildApp } from '#src/app.js';
import { createMetrics } from '#src/metrics/index.js';

async function scrape(metrics = createMetrics()): Promise<string> {
  const app = await buildApp({ metrics });
  const response = await app.inject({ method: 'GET', url: '/metrics' });
  await app.close();
  expect(response.statusCode).toBe(200);
  return response.body;
}

describe('GET /metrics', () => {
  it('serves Prometheus text without auth', async () => {
    const app = await buildApp({ metrics: createMetrics() });

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
    const app = await buildApp({ metrics: createMetrics() });

    const doc = (await app.inject({ method: 'GET', url: '/v3/api-docs' })).json();
    expect(doc.paths['/metrics']).toBeUndefined();
    expect(doc.paths['/healthz'].get).toBeDefined();

    await app.close();
  });

  it('exposes in-process counters and the retry histogram after increments', async () => {
    const metrics = createMetrics();
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
    const first = createMetrics();
    first.recordMessageTerminal('DELIVERY_FAILED', 0);
    const secondBody = await scrape(createMetrics());
    expect(secondBody).not.toContain('status="DELIVERY_FAILED"');
  });
});
