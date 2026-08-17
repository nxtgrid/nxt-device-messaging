import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '#src/app.js';
import { createPluginRegistry } from '#src/plugins/registry.js';
import { STUB_PULL_ID, STUB_PUSH_ID } from '#src/plugins/stub/index.js';
import { createInMemoryIncomingService } from '../../helpers/in-memory-incoming.js';
import { noopMetrics } from '../../helpers/noop-metrics.js';

describe('POST /ingress/:pluginId', () => {
  it('forwards body to incoming.handle without Bearer auth', async () => {
    const onHandle = vi.fn();
    const app = await buildApp({
      metrics: noopMetrics,
      incomingService: createInMemoryIncomingService({ onHandle }),
      registry: createPluginRegistry([ { id: STUB_PUSH_ID } ]),
      apiKey: 'secret',
    });

    const payload = {
      deliveryStatus: 'DELIVERY_SUCCESSFUL',
      device: { type: 'ELECTRICITY_METER', externalReference: 'm-1' },
    };

    const response = await app.inject({
      method: 'POST',
      url: `/ingress/${ STUB_PUSH_ID }?event=up`,
      headers: { 'content-type': 'application/json' },
      payload,
    });

    expect(response.statusCode).toBe(204);
    expect(onHandle).toHaveBeenCalledWith(
      payload,
      expect.objectContaining({ id: STUB_PUSH_ID }),
      { query: { event: 'up' } },
    );

    await app.close();
  });

  it('returns 400 for unknown pluginId', async () => {
    const app = await buildApp({
      metrics: noopMetrics,
      incomingService: createInMemoryIncomingService(),
      registry: createPluginRegistry([]),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/ingress/no-such-plugin',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Unknown or disabled pluginId: no-such-plugin',
    });

    await app.close();
  });

  it('returns 400 when plugin has no PUSH handle', async () => {
    const app = await buildApp({
      metrics: noopMetrics,
      incomingService: createInMemoryIncomingService(),
      registry: createPluginRegistry([ { id: STUB_PULL_ID } ]),
    });

    const response = await app.inject({
      method: 'POST',
      url: `/ingress/${ STUB_PULL_ID }`,
      headers: { 'content-type': 'application/json' },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: `Plugin does not support PUSH ingress: ${ STUB_PULL_ID }`,
    });

    await app.close();
  });
});
