import { describe, expect, it } from 'vitest';

import { buildApp } from '#src/app.js';

describe('OpenAPI / Swagger UI', () => {
  it('serves OpenAPI JSON at /v3/api-docs including /healthz', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/v3/api-docs',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.openapi).toMatch(/^3\./);
    expect(body.info.title).toBe('NXT Device Messaging');
    expect(body.info.version).toBe('0.0.0');
    expect(body.paths['/healthz'].get).toBeDefined();

    await app.close();
  });

  it('serves Swagger UI at /swagger without auth', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/swagger',
    });

    // UI may redirect to a trailing-slash or static index; either is fine.
    expect(response.statusCode).toBeGreaterThanOrEqual(200);
    expect(response.statusCode).toBeLessThan(400);

    await app.close();
  });
});
