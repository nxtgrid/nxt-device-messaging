import { describe, expect, it } from 'vitest';

import { buildApp } from '#src/app.js';

describe('GET /metrics', () => {
  it('serves Prometheus text without auth', async () => {
    const app = await buildApp();

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
    const app = await buildApp();

    const doc = (await app.inject({ method: 'GET', url: '/v3/api-docs' })).json();
    expect(doc.paths['/metrics']).toBeUndefined();
    expect(doc.paths['/healthz'].get).toBeDefined();

    await app.close();
  });
});
