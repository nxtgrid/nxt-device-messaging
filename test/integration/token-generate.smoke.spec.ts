/**
 * Real createTokenService + thin POST /token/generate smoke (Unit 5.6 Step A).
 * No Valkey — sync plugin call via stub-push.
 *
 *   pnpm exec vitest run test/integration/token-generate.smoke.spec.ts
 */
import { describe, expect, it } from 'vitest';

import { buildApp } from '#src/app.js';
import { createTokenService } from '#src/engine/token.js';
import { createPluginRegistry } from '#src/plugins/registry.js';
import {
  STUB_PULL_ID,
  STUB_PUSH_ID,
  STUB_TOKEN_VALUE,
} from '#src/plugins/stub/index.js';

describe('token generate (stub-push)', () => {
  it('POST /token/generate → { token: stub-token }', async () => {
    const registry = createPluginRegistry([
      { id: STUB_PUSH_ID },
      { id: STUB_PULL_ID },
    ]);
    const tokenService = createTokenService({ registry });
    const app = await buildApp({ tokenService });

    const ok = await app.inject({
      method: 'POST',
      url: '/token/generate',
      payload: {
        pluginId: STUB_PUSH_ID,
        type: 'TOP_UP_KWH',
        issueDateString: '2026-08-03',
        device: {
          externalReference: 'smoke-meter',
          decoderKey: 'aabbcc',
        },
        payload: { kwh: 5 },
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ token: STUB_TOKEN_VALUE });

    const noToken = await app.inject({
      method: 'POST',
      url: '/token/generate',
      payload: {
        pluginId: STUB_PULL_ID,
        type: 'TOP_UP_KWH',
        issueDateString: '2026-08-03',
        device: { externalReference: 'smoke-meter' },
      },
    });
    expect(noToken.statusCode).toBe(400);
    expect(noToken.json()).toEqual({
      error: `Plugin does not support token generation: ${ STUB_PULL_ID }`,
    });

    await app.close();
  });
});
