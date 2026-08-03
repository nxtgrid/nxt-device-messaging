import { describe, expect, it } from 'vitest';

import { buildApp } from '../../../src/app.js';
import { createPluginRegistry } from '../../../src/plugins/registry.js';
import { createInMemoryIncoming } from '../../helpers/in-memory-incoming.js';
import { createInMemoryOutgoing } from '../../helpers/in-memory-outgoing.js';

describe('GET /healthz', () => {
  it('returns 200 with ok: true', async () => {
    const app = await buildApp({
      outgoing: createInMemoryOutgoing(),
      incoming: createInMemoryIncoming(),
      registry: createPluginRegistry([]),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    await app.close();
  });
});
