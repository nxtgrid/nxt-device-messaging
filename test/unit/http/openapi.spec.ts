import { describe, expect, it } from 'vitest';

import { buildApp } from '#src/app.js';
import { STUB_PUSH_ID } from '#src/plugins/stub/index.js';
import { createInMemoryOutgoingService } from '../../helpers/in-memory-outgoing.js';
import { createInMemoryTokenService } from '../../helpers/in-memory-token.js';

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

  it('documents command and token paths when services are wired', async () => {
    const app = await buildApp({
      outgoingService: createInMemoryOutgoingService({ knownPluginIds: [ STUB_PUSH_ID ] }),
      tokenService: createInMemoryTokenService({ knownPluginIds: [ STUB_PUSH_ID ] }),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v3/api-docs',
    });

    expect(response.statusCode).toBe(200);
    const paths = response.json().paths;
    expect(paths['/message/enqueue'].post).toBeDefined();
    expect(paths['/message/{correlationId}'].get).toBeDefined();
    expect(paths['/message/cancel'].post).toBeDefined();
    expect(paths['/messages/cancel'].post).toBeDefined();
    expect(paths['/token/generate'].post).toBeDefined();

    await app.close();
  });

  it('documents SET_DATE payload with calendar bounds and year example 2026', async () => {
    const app = await buildApp({
      outgoingService: createInMemoryOutgoingService({ knownPluginIds: [ STUB_PUSH_ID ] }),
    });

    const doc = (await app.inject({ method: 'GET', url: '/v3/api-docs' })).json();
    const enqueueSchema = doc.paths['/message/enqueue'].post.requestBody
      .content['application/json'].schema;
    const dateBranch = enqueueSchema.properties.requestData.properties.payload.anyOf[0];

    expect(dateBranch.properties.year).toMatchObject({
      minimum: 0,
      maximum: 9999,
      examples: [ 2026 ],
    });
    expect(dateBranch.properties.month).toMatchObject({ minimum: 1, maximum: 12 });
    expect(dateBranch.properties.day).toMatchObject({ minimum: 1, maximum: 31 });
    expect(JSON.stringify(dateBranch)).not.toContain('-9007199254740991');

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
