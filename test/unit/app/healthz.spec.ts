import { describe, expect, it } from 'vitest';

import { buildApp } from '../../../src/app.js';

describe('GET /healthz', () => {
  it('returns 200 with ok: true', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    await app.close();
  });
});
