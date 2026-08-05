import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CalinApiV1Error,
  createCalinApiV1Client,
} from '#src/plugins/calin-api-v1/lib/repo.js';

const API_BASE = 'https://calin.example';

function jsonResponse(
  body: unknown,
  init: { status?: number; contentType?: string } = {},
): Response {
  const status = init.status ?? 200;
  const contentType = init.contentType ?? 'application/json';
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': contentType },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createCalinApiV1Client', () => {
  it('POSTs JSON to apiBaseUrl + path and returns the body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ ResultCode: '00', Reason: 'OK' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = createCalinApiV1Client({ apiBaseUrl: API_BASE });
    const body = { MeterNo: 'm-1', CompanyName: 'co' };
    const data = await client.sendRequest('/COMM_RemoteReading', body);

    expect(data).toEqual({ ResultCode: '00', Reason: 'OK' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      `${ API_BASE }/COMM_RemoteReading`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
  });

  it('returns data when vendor result codes are unexpected (logs only)', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ result_code: 1, reason: 'nope' }),
      ),
    );

    const client = createCalinApiV1Client({ apiBaseUrl: API_BASE });
    await expect(
      client.sendRequest('/POS_Purchase', { meter_number: 'm-1' }),
    ).resolves.toEqual({ result_code: 1, reason: 'nope' });
    expect(infoSpy).toHaveBeenCalled();
  });

  it('maps HTML responses to CalinApiV1Error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('<html>crash</html>', {
          status: 500,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        }),
      ),
    );

    const client = createCalinApiV1Client({ apiBaseUrl: API_BASE });
    await expect(
      client.sendRequest('/COMM_RemoteReading', { MeterNo: 'm-1' }),
    ).rejects.toMatchObject({
      name: 'CalinApiV1Error',
      message: '[CALIN V1 API] responded with a HTML page..',
      code: 500,
    });
  });

  it('maps non-OK JSON responses to CalinApiV1Error with Message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ Message: 'backend gone' }, { status: 503 }),
      ),
    );

    const client = createCalinApiV1Client({ apiBaseUrl: API_BASE });
    await expect(
      client.sendRequest('/COMM_RemoteControl', { MeterNo: 'm-1' }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'CalinApiV1Error',
        message: '[CALIN V1 API] is down: backend gone',
        code: 503,
      }),
    );
  });

  it('maps ECONNREFUSED (via cause.code) to CalinApiV1Error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      }),
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(refused));

    const client = createCalinApiV1Client({ apiBaseUrl: API_BASE });
    await expect(
      client.sendRequest('/COMM_RemoteReading', { MeterNo: 'm-1' }),
    ).rejects.toEqual(
      new CalinApiV1Error(
        '[CALIN V1 API] could not be reached, connection was refused',
        'ECONNREFUSED',
      ),
    );
  });

  it('maps ECONNRESET (via cause.code) to CalinApiV1Error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reset = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(reset));

    const client = createCalinApiV1Client({ apiBaseUrl: API_BASE });
    await expect(
      client.sendRequest('/COMM_RemoteReading', { MeterNo: 'm-1' }),
    ).rejects.toMatchObject({
      message: '[CALIN V1 API] abruptly closed its end of the connection',
      code: 'ECONNRESET',
    });
  });

  it('maps generic fetch failures to CalinApiV1Error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('something else')),
    );

    const client = createCalinApiV1Client({ apiBaseUrl: API_BASE });
    await expect(
      client.sendRequest('/COMM_RemoteReading', { MeterNo: 'm-1' }),
    ).rejects.toMatchObject({
      name: 'CalinApiV1Error',
      message: '[CALIN V1 API] is down',
      code: null,
    });
  });
});
