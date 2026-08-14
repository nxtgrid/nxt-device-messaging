import { describe, expect, it } from 'vitest';

import { buildApp } from '#src/app.js';
import { noopMetrics } from '../../helpers/noop-metrics.js';

describe('GET /healthz', () => {
  it('returns 200 with ok: true without engine services', async () => {
    const app = await buildApp({ metrics: noopMetrics });

    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    await app.close();
  });
});
