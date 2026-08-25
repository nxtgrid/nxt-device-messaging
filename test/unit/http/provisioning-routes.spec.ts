import { describe, expect, it } from 'vitest';

import { buildApp } from '#src/app.js';
import { STUB_PUSH_ID } from '#src/plugins/stub/index.js';
import { createInMemoryProvisioningService } from '../../helpers/in-memory-provisioning.js';
import { noopMetrics } from '../../helpers/noop-metrics.js';

const executeBody = {
  pluginId: STUB_PUSH_ID,
  operation: 'registerDevice',
  payload: { devEui: '0000000000000001', deviceName: 'METER-1001' },
};

describe('POST /plugin/provisioning', () => {
  it('returns { result } on success', async () => {
    const app = await buildApp({
      metrics: noopMetrics,
      provisioningService: createInMemoryProvisioningService({
        knownPluginIds: [ STUB_PUSH_ID ],
        result: { isNewRegistration: true },
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/plugin/provisioning',
      payload: executeBody,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ result: { isNewRegistration: true } });

    await app.close();
  });

  it('maps UnknownPluginError to 400', async () => {
    const app = await buildApp({
      metrics: noopMetrics,
      provisioningService: createInMemoryProvisioningService({
        knownPluginIds: [ STUB_PUSH_ID ],
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/plugin/provisioning',
      payload: { ...executeBody, pluginId: 'calin-chirpstack' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Unknown or disabled pluginId: calin-chirpstack',
    });

    await app.close();
  });

  it('maps ProvisioningNotSupportedError to 400', async () => {
    const app = await buildApp({
      metrics: noopMetrics,
      provisioningService: createInMemoryProvisioningService({
        knownPluginIds: [ STUB_PUSH_ID ],
        unsupportedPluginIds: [ STUB_PUSH_ID ],
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/plugin/provisioning',
      payload: executeBody,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: `Plugin does not support provisioning: ${ STUB_PUSH_ID }`,
    });

    await app.close();
  });

  it('maps InvalidProvisioningError to 400', async () => {
    const app = await buildApp({
      metrics: noopMetrics,
      provisioningService: createInMemoryProvisioningService({
        knownPluginIds: [ STUB_PUSH_ID ],
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/plugin/provisioning',
      payload: { ...executeBody, operation: 'invalid' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: `Plugin ${ STUB_PUSH_ID }: unsupported operation: invalid`,
    });

    await app.close();
  });

  it('returns 400 for invalid body', async () => {
    const app = await buildApp({
      metrics: noopMetrics,
      provisioningService: createInMemoryProvisioningService(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/plugin/provisioning',
      payload: { pluginId: STUB_PUSH_ID },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as {
      error: string;
      issues: { path: string; message: string }[];
    };
    expect(body.error).toBe('Invalid request body');
    expect(body.issues.length).toBeGreaterThan(0);

    await app.close();
  });

  it('requires Bearer when apiKey is configured', async () => {
    const app = await buildApp({
      metrics: noopMetrics,
      provisioningService: createInMemoryProvisioningService({
        knownPluginIds: [ STUB_PUSH_ID ],
      }),
      apiKey: 'secret',
    });

    const unauthorized = await app.inject({
      method: 'POST',
      url: '/plugin/provisioning',
      payload: executeBody,
    });
    expect(unauthorized.statusCode).toBe(401);

    const authorized = await app.inject({
      method: 'POST',
      url: '/plugin/provisioning',
      headers: { authorization: 'Bearer secret' },
      payload: executeBody,
    });
    expect(authorized.statusCode).toBe(200);

    await app.close();
  });
});
