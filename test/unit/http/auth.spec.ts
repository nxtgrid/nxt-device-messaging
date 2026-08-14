import { describe, expect, it } from 'vitest';

import { buildApp } from '#src/app.js';
import { STUB_PUSH_ID } from '#src/plugins/stub/index.js';
import { createInMemoryOutgoingService } from '../../helpers/in-memory-outgoing.js';
import { noopMetrics } from '../../helpers/noop-metrics.js';

const API_KEY = 'secret';
const UNAUTHORIZED = { error: 'Unauthorized' };

async function commandApp(apiKey?: string) {
  return buildApp({
    metrics: noopMetrics,
    outgoingService: createInMemoryOutgoingService({ knownPluginIds: [ STUB_PUSH_ID ] }),
    apiKey,
  });
}

async function getMessage(app: Awaited<ReturnType<typeof buildApp>>, authorization?: string) {
  return app.inject({
    method: 'GET',
    url: '/message/corr-1',
    headers: authorization === undefined ? {} : { authorization },
  });
}

describe('command API Bearer auth', () => {
  it('skips the hook when apiKey is unset', async () => {
    const app = await commandApp();
    const response = await getMessage(app);
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('skips the hook when apiKey is empty', async () => {
    const app = await commandApp('');
    const response = await getMessage(app);
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('accepts a matching Bearer token (scheme case-insensitive)', async () => {
    const app = await commandApp(API_KEY);

    const canonical = await getMessage(app, `Bearer ${ API_KEY }`);
    expect(canonical.statusCode).toBe(404);

    const lower = await getMessage(app, `bearer ${ API_KEY }`);
    expect(lower.statusCode).toBe(404);

    await app.close();
  });

  it.each([
    [ '(missing)', undefined ],
    [ 'wrong scheme', 'Basic secret' ],
    [ 'scheme only', 'Bearer' ],
    [ 'empty token', 'Bearer ' ],
    [ 'wrong key, same length', 'Bearer secrat' ],
    [ 'wrong key, shorter', 'Bearer secre' ],
    [ 'wrong key, longer', 'Bearer secret-extra' ],
  ] as const)('returns 401 for %s', async (_label, authorization) => {
    const app = await commandApp(API_KEY);
    const response = await getMessage(app, authorization);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(UNAUTHORIZED);
    await app.close();
  });

  it('does not apply the hook to /healthz', async () => {
    const app = await commandApp(API_KEY);
    const healthz = await app.inject({ method: 'GET', url: '/healthz' });
    expect(healthz.statusCode).toBe(200);
    await app.close();
  });
});
