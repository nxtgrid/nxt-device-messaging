import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DeviceMessage } from '#src/lib/device-message/types.js';
import { CLIENT_SAFETY_DEADLINE_MS } from '#src/plugins/_shared/client-safety-deadline.js';
import { buildConfigureMeterBody } from '#src/plugins/sparkmeter-sparknet-http/lib/configure-body.js';
import type { SparkmeterSparknetHttpSettings } from '#src/plugins/sparkmeter-sparknet-http/lib/settings.js';
import { SPARKMETER_SPARKNET_HTTP_ID } from '#src/plugins/sparkmeter-sparknet-http/index.js';
import { createSparkmeterSparknetHttpOutgoing } from '#src/plugins/sparkmeter-sparknet-http/outgoing.js';

const settings: SparkmeterSparknetHttpSettings = {
  basestations: [
    { id: 1, baseUrl: 'http://127.0.0.1:18080' },
    { id: 2, baseUrl: 'http://10.0.0.8:18080/' },
  ],
  meterConfiguration: {
    currentLimit: 200,
    startupDelay: 0,
    throttleOnTime: 5,
    throttleOffTime: 10,
    throttleCountLimit: 5,
  },
};

function message(
  overrides: Partial<DeviceMessage> & Pick<DeviceMessage, 'commandType'>,
): DeviceMessage {
  return {
    id: 'msg-1',
    priority: 10,
    pluginId: SPARKMETER_SPARKNET_HTTP_ID,
    networkId: null,
    deliveryQueueId: '',
    deliveryStatus: 'QUEUED',
    device: {
      type: 'ELECTRICITY_METER',
      externalReference: '1001',
      relayNode: { id: 1 },
    },
    requestData: { deviceState: { powerLimit: 0 } },
    ...overrides,
  };
}

function outgoing() {
  return createSparkmeterSparknetHttpOutgoing({
    settings,
    pluginId: SPARKMETER_SPARKNET_HTTP_ID,
  });
}

function accepted(): Response {
  return new Response(JSON.stringify({ accepted: true }), {
    status: 202,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createSparkmeterSparknetHttpOutgoing', () => {
  it('posts the path-form configure body and returns pluginId:nodeId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(accepted());
    vi.stubGlobal('fetch', fetchMock);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const command = message({ commandType: 'TURN_ON' });

    await expect(outgoing().sendOne(command)).resolves.toBe(
      `${ SPARKMETER_SPARKNET_HTTP_ID }:1001`,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [ url, init ] = fetchMock.mock.calls[ 0 ] ?? [];
    expect(url).toBe('http://127.0.0.1:18080/v1/nodes/1001/configure-meter');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init?.body))).toEqual(
      buildConfigureMeterBody(command, settings.meterConfiguration),
    );
    expect(timeout).toHaveBeenCalledWith(CLIENT_SAFETY_DEADLINE_MS);
  });

  it('uses the basestation base URL and strips a trailing slash', async () => {
    const fetchMock = vi.fn().mockResolvedValue(accepted());
    vi.stubGlobal('fetch', fetchMock);

    await outgoing().sendOne(message({
      commandType: 'SET_POWER_LIMIT',
      requestData: {
        payload: { powerLimit: 1200 },
        deviceState: { relay: 'OFF' },
      },
      device: {
        type: 'ELECTRICITY_METER',
        externalReference: '42',
        relayNode: { id: 2 },
      },
    }));

    expect(fetchMock.mock.calls[ 0 ]?.[ 0 ]).toBe(
      'http://10.0.0.8:18080/v1/nodes/42/configure-meter',
    );
  });

  it('does not retry a 4xx and does retry a 5xx, a timeout, and a network error', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const send = outgoing();
    const command = message({ commandType: 'TURN_OFF' });

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 409 }));
    const rejected = await send.sendOne(command).catch(err => err);
    expect(send.parseError(rejected)).toEqual({
      reason: 'configure-meter answered HTTP 409',
      errorCode: 409,
      skipRetry: true,
    });

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    const unavailable = await send.sendOne(command).catch(err => err);
    expect(send.parseError(unavailable)).toEqual({
      reason: 'configure-meter answered HTTP 503',
      errorCode: 503,
      skipRetry: false,
    });

    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    fetchMock.mockRejectedValueOnce(timeout);
    const timedOut = await send.sendOne(command).catch(err => err);
    expect(send.parseError(timedOut)).toEqual({
      reason: 'configure-meter timed out',
      skipRetry: false,
    });

    fetchMock.mockRejectedValueOnce(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }));
    const unreachable = await send.sendOne(command).catch(err => err);
    expect(send.parseError(unreachable)).toEqual({
      reason: 'configure-meter could not be reached',
      skipRetry: false,
    });
  });

  it('does not retry a command aimed at an unknown basestation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(accepted());
    vi.stubGlobal('fetch', fetchMock);
    const send = outgoing();

    const err = await send.sendOne(message({
      commandType: 'TURN_ON',
      device: {
        type: 'ELECTRICITY_METER',
        externalReference: '1001',
        relayNode: { id: 9 },
      },
    })).catch(caught => caught);

    expect(send.parseError(err)).toEqual({
      reason: 'device.relayNode.id is not a configured basestation',
      skipRetry: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
