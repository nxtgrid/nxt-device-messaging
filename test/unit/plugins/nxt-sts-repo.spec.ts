import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createNxtStsClient,
  NxtStsError,
} from '#src/plugins/nxt-sts/lib/repo.js';

const API_BASE = 'https://sts.example';

const sampleBody = {
  decoderKey: '0123456789ABCDEF',
  randomNumber: 6,
  issueDate: '2026-08-05T10:30:00',
  type: 'TOP_UP_KWH' as const,
  kwh: 10,
};

function jsonResponse(
  body: unknown,
  init: { status?: number } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createNxtStsClient', () => {
  it('POSTs JSON to apiBaseUrl/token and returns the body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ token: 'tok-1' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = createNxtStsClient({ apiBaseUrl: API_BASE });
    const data = await client.sendTokenRequest(sampleBody);

    expect(data).toEqual({ token: 'tok-1' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      `${ API_BASE }/token`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(sampleBody),
      }),
    );
  });

  it('maps non-OK responses to NxtStsError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: 'nope' }, { status: 503 })),
    );

    const client = createNxtStsClient({ apiBaseUrl: API_BASE });
    await expect(client.sendTokenRequest(sampleBody)).rejects.toEqual(
      new NxtStsError('[NXT STS TOKEN SERVICE] Failed to generate token'),
    );
  });

  it('maps network failures to NxtStsError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('fetch failed')),
    );

    const client = createNxtStsClient({ apiBaseUrl: API_BASE });
    await expect(client.sendTokenRequest(sampleBody)).rejects.toMatchObject({
      name: 'NxtStsError',
      message: '[NXT STS TOKEN SERVICE] Failed to generate token',
    });
  });
});
