import { describe, expect, it } from 'vitest';

import { buildApp } from '#src/app.js';
import { STUB_PUSH_ID, STUB_TOKEN_VALUE } from '#src/plugins/stub/index.js';
import { createInMemoryTokenService } from '../../helpers/in-memory-token.js';

const generateBody = {
  pluginId: STUB_PUSH_ID,
  type: 'TOP_UP_KWH',
  issueDateString: '2026-08-03',
  device: {
    externalReference: 'm-1',
    decoderKey: 'deadbeef',
  },
  payload: { kwh: 10 },
};

describe('POST /token/generate', () => {
  it('returns { token } on success', async () => {
    const app = await buildApp({
      tokenService: createInMemoryTokenService({
        knownPluginIds: [ STUB_PUSH_ID ],
        tokenValue: STUB_TOKEN_VALUE,
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/token/generate',
      payload: generateBody,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ token: STUB_TOKEN_VALUE });

    await app.close();
  });

  it('maps UnknownPluginError to 400', async () => {
    const app = await buildApp({
      tokenService: createInMemoryTokenService({ knownPluginIds: [ STUB_PUSH_ID ] }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/token/generate',
      payload: { ...generateBody, pluginId: 'calin-chirpstack' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Unknown or disabled pluginId: calin-chirpstack',
    });

    await app.close();
  });

  it('maps TokenNotSupportedError to 400', async () => {
    const app = await buildApp({
      tokenService: createInMemoryTokenService({
        knownPluginIds: [ STUB_PUSH_ID ],
        unsupportedPluginIds: [ STUB_PUSH_ID ],
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/token/generate',
      payload: generateBody,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: `Plugin does not support token generation: ${ STUB_PUSH_ID }`,
    });

    await app.close();
  });

  it('returns 400 for invalid body', async () => {
    const app = await buildApp({
      tokenService: createInMemoryTokenService(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/token/generate',
      payload: { pluginId: STUB_PUSH_ID },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Invalid request body' });

    await app.close();
  });

  it('requires Bearer when apiKey is configured', async () => {
    const app = await buildApp({
      tokenService: createInMemoryTokenService({ knownPluginIds: [ STUB_PUSH_ID ] }),
      apiKey: 'secret',
    });

    const unauthorized = await app.inject({
      method: 'POST',
      url: '/token/generate',
      payload: generateBody,
    });
    expect(unauthorized.statusCode).toBe(401);

    const authorized = await app.inject({
      method: 'POST',
      url: '/token/generate',
      headers: { authorization: 'Bearer secret' },
      payload: generateBody,
    });
    expect(authorized.statusCode).toBe(200);

    await app.close();
  });
});
