import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../../src/app.js';
import { createPluginRegistry } from '../../../src/plugins/registry.js';
import { STUB_PULL_ID, STUB_PUSH_ID } from '../../../src/plugins/stub/index.js';
import { createInMemoryIncomingService } from '../../helpers/in-memory-incoming.js';

describe('POST /ingress/:pluginId', () => {
  it('forwards body to incoming.handle without Bearer auth', async () => {
    const onHandle = vi.fn();
    const app = await buildApp({
      incomingService: createInMemoryIncomingService({ onHandle }),
      registry: createPluginRegistry([ { id: STUB_PUSH_ID } ]),
      apiKey: 'secret',
    });

    const response = await app.inject({
      method: 'POST',
      url: `/ingress/${ STUB_PUSH_ID }`,
      headers: { 'content-type': 'application/json' },
      payload: {
        deliveryStatus: 'DELIVERY_SUCCESSFUL',
        device: { type: 'ELECTRICITY_METER', externalReference: 'm-1' },
      },
    });

    expect(response.statusCode).toBe(204);
    expect(onHandle).toHaveBeenCalledOnce();
    expect(onHandle.mock.calls[0]?.[1]?.id).toBe(STUB_PUSH_ID);

    await app.close();
  });

  it('returns 400 for unknown pluginId', async () => {
    const app = await buildApp({
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
