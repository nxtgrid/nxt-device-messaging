import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CalinApiV2Error,
  createCalinApiV2Client,
} from '#src/plugins/calin-api-v2/lib/repo.js';

const API_BASE = 'https://calin-v2.example';

const CLIENT_DEPS = {
  apiBaseUrl: API_BASE,
  adminUsername: 'admin',
  adminPassword: 'secret',
  companyName: 'NXT',
} as const;

/**
 * Compact unsigned JWT with `exp` (seconds). Signature is ignored by the client.
 */
function fakeJwt(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `${ header }.${ payload }.sig`;
}

function jsonResponse(
  body: unknown,
  init: { status?: number } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function loginOk(expSeconds = Math.floor(Date.now() / 1000) + 3_600): Response {
  return jsonResponse({
    code: 0,
    reason: 'success',
    result: { token: fakeJwt(expSeconds) },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createCalinApiV2Client', () => {
  it('logs in then POSTs JSON with Bearer auth and returns the body', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, reason: 'success', result: [ { id: 't-1' } ] }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = createCalinApiV2Client(CLIENT_DEPS);
    const body = [ { meterId: 'm-1', protocolId: 39, customerId: '1', company: 'NXT' } ];
    const data = await client.sendRequest('/API/RemoteMeterTask/CreateReadingTask', body);

    expect(data).toEqual({ code: 0, reason: 'success', result: [ { id: 't-1' } ] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `${ API_BASE }/API/User/Login`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          userId: 'admin',
          password: 'secret',
          company: 'NXT',
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `${ API_BASE }/API/RemoteMeterTask/CreateReadingTask`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(body),
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^Bearer /),
        }),
      }),
    );
  });

  it('reuses a cached token for a second request', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce(jsonResponse({ code: 0, reason: 'success' }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, reason: 'success' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createCalinApiV2Client(CLIENT_DEPS);
    await client.sendRequest('/API/a', { x: 1 });
    await client.sendRequest('/API/b', { y: 2 });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${ API_BASE }/API/User/Login`);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`${ API_BASE }/API/a`);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(`${ API_BASE }/API/b`);
  });

  it('shares one in-flight login across concurrent callers', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/API/User/Login')) {
        await new Promise<void>(resolve => {
          setTimeout(resolve, 20);
        });
        return loginOk();
      }
      return jsonResponse({ code: 0, reason: 'success' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createCalinApiV2Client(CLIENT_DEPS);
    await Promise.all([
      client.sendRequest('/API/a', { x: 1 }),
      client.sendRequest('/API/b', { y: 2 }),
    ]);

    expect(fetchMock.mock.calls.filter(call =>
      String(call[0]).endsWith('/API/User/Login'),
    )).toHaveLength(1);
  });

  it('refreshes when the cached token is within the expiry skew window', async () => {
    // Still valid, but fewer than TOKEN_EXPIRY_SKEW_MS (1s) remain → must refresh.
    const withinSkewSeconds = Date.now() / 1000 + 0.5;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginOk(withinSkewSeconds))
      .mockResolvedValueOnce(jsonResponse({ code: 0, reason: 'success' }))
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce(jsonResponse({ code: 0, reason: 'success' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createCalinApiV2Client(CLIENT_DEPS);
    await client.sendRequest('/API/a', { x: 1 });
    await client.sendRequest('/API/b', { y: 2 });

    expect(fetchMock.mock.calls.filter(call =>
      String(call[0]).endsWith('/API/User/Login'),
    )).toHaveLength(2);
  });

  it('re-logins after HTTP 401 and retries the request', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce(jsonResponse({}, { status: 401 }))
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, reason: 'success', result: { token: 'tok' } }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = createCalinApiV2Client(CLIENT_DEPS);
    await expect(
      client.sendRequest('/API/Token/CreditToken/Generate', { meterId: 'm-1' }),
    ).resolves.toEqual({ code: 0, reason: 'success', result: { token: 'tok' } });

    expect(fetchMock.mock.calls.filter(call =>
      String(call[0]).endsWith('/API/User/Login'),
    )).toHaveLength(2);
  });

  it('throws a distinct auth error when 401 persists after token refresh', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce(jsonResponse({}, { status: 401 }))
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce(jsonResponse({}, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createCalinApiV2Client(CLIENT_DEPS);
    await expect(client.sendRequest('/API/x', { a: 1 })).rejects.toEqual(
      new CalinApiV2Error('[CALIN API-V2] Unauthorized after token refresh'),
    );

    // login, authorized 401, re-login, authorized 401 — no further identical retries
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('returns data when vendor code/reason are unexpected (logs only)', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce(loginOk())
        .mockResolvedValueOnce(jsonResponse({ code: 1, reason: 'nope' })),
    );

    const client = createCalinApiV2Client(CLIENT_DEPS);
    await expect(
      client.sendRequest('/API/x', { a: 1 }),
    ).resolves.toEqual({ code: 1, reason: 'nope' });
    expect(infoSpy).toHaveBeenCalled();
  });

  it('throws when login never yields a token', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ reason: 'bad creds' })),
    );

    const client = createCalinApiV2Client(CLIENT_DEPS);
    await expect(client.sendRequest('/API/x', { a: 1 })).rejects.toEqual(
      new CalinApiV2Error('CALIN API-V2 failed to get a token'),
    );
  });

  it('throws when login returns a token with unreadable exp', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({
        code: 0,
        reason: 'success',
        result: { token: 'not-a-jwt' },
      })),
    );

    const client = createCalinApiV2Client(CLIENT_DEPS);
    await expect(client.sendRequest('/API/x', { a: 1 })).rejects.toEqual(
      new CalinApiV2Error('CALIN API-V2 failed to get a token'),
    );
  });

  it('throws CalinApiV2Error after repeated transport failures', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginOk())
      .mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const client = createCalinApiV2Client(CLIENT_DEPS);
    await expect(client.sendRequest('/API/x', { a: 1 })).rejects.toEqual(
      new CalinApiV2Error('CALIN API-V2 is down'),
    );
  });

  it('throws after 401 refresh when the retry wave hits transport failures', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce(jsonResponse({}, { status: 401 }))
      .mockResolvedValueOnce(loginOk())
      .mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const client = createCalinApiV2Client(CLIENT_DEPS);
    await expect(client.sendRequest('/API/x', { a: 1 })).rejects.toEqual(
      new CalinApiV2Error('CALIN API-V2 is down'),
    );

    // login, authorized 401, re-login, then FETCH_RETRIES (3) transport attempts
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});
