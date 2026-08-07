import { describe, expect, it, vi } from 'vitest';

import type { DeviceMessage } from '#src/lib/device-message/types.js';
import { createCalinApiV2Incoming } from '#src/plugins/calin-api-v2/incoming.js';
import {
  CalinApiV2Error,
  type CalinApiV2Client,
  type CalinApiV2DataItem,
  type CalinApiV2TaskDataResponse,
} from '#src/plugins/calin-api-v2/lib/repo.js';

const companySecrets = {
  companyName: 'Acme',
} as const;

function baseMessage(
  overrides: Partial<DeviceMessage> & Pick<DeviceMessage, 'commandType'>,
): DeviceMessage {
  return {
    id: 'msg-1',
    priority: 0,
    pluginId: 'calin-api-v2',
    networkId: 1,
    deliveryQueueId: '3800',
    deliveryStatus: 'SENT_TO_NS',
    device: { type: 'ELECTRICITY_METER', externalReference: 'm-1' },
    ...overrides,
  };
}

function mockClient(
  sendRequest: CalinApiV2Client['sendRequest'],
): CalinApiV2Client {
  return { sendRequest };
}

function taskData(opts: {
  status: 0 | 1 | 2 | 3;
  name?: CalinApiV2DataItem;
  data?: number | string;
  reason?: string;
}): CalinApiV2TaskDataResponse {
  return {
    code: 0,
    reason: opts.reason ?? 'success',
    result: {
      data: [ {
        name: opts.name ?? 'Current Credit Balance',
        status: opts.status,
        data: opts.data ?? '108.8',
      } ],
    },
  };
}

describe('createCalinApiV2Incoming', () => {
  it('fetchStatus polls GetReadingTask for reads', async () => {
    const sendRequest = vi.fn().mockResolvedValue(taskData({ status: 0 }));
    const incoming = createCalinApiV2Incoming({
      secrets: companySecrets,
      client: mockClient(sendRequest),
    });

    await expect(
      incoming.fetchStatus!(baseMessage({ commandType: 'READ_CREDIT' })),
    ).resolves.toBeNull();

    expect(sendRequest).toHaveBeenCalledWith(
      '/API/RemoteMeterTask/GetReadingTask',
      {
        id: 3800,
        lang: 'en',
        company: 'Acme',
      },
    );
  });

  it('returns null while status is Processing (0)', async () => {
    const incoming = createCalinApiV2Incoming({
      secrets: companySecrets,
      client: mockClient(vi.fn().mockResolvedValue(taskData({ status: 0 }))),
    });

    await expect(
      incoming.fetchStatus!(baseMessage({ commandType: 'TURN_ON' })),
    ).resolves.toBeNull();
  });

  it('parses READ_CREDIT success with camelCase response.data', async () => {
    const incoming = createCalinApiV2Incoming({
      secrets: companySecrets,
      client: mockClient(vi.fn().mockResolvedValue(
        taskData({
          status: 1,
          name: 'Current Credit Balance',
          data: '12.5',
        }),
      )),
    });

    await expect(
      incoming.fetchStatus!(baseMessage({ commandType: 'READ_CREDIT' })),
    ).resolves.toEqual({
      deliveryQueueId: '3800',
      commandType: 'READ_CREDIT',
      device: { type: 'ELECTRICITY_METER', externalReference: 'm-1' },
      deliveryStatus: 'DELIVERY_SUCCESSFUL',
      response: {
        status: 'EXECUTION_SUCCESS',
        data: { kwhCreditAvailable: 12.5 },
      },
    });
  });

  it('uses camelCase powerLimit for Maximum power threshold', async () => {
    const incoming = createCalinApiV2Incoming({
      secrets: companySecrets,
      client: mockClient(vi.fn().mockResolvedValue(
        taskData({
          status: 1,
          name: 'Maximum power threshold',
          data: 5000,
        }),
      )),
    });

    const event = await incoming.fetchStatus!(
      baseMessage({ commandType: 'READ_POWER_LIMIT' }),
    );
    expect(event?.response?.data).toEqual({ powerLimit: 5000 });
  });

  it('parses Clock(time) read into year/month/day', async () => {
    const incoming = createCalinApiV2Incoming({
      secrets: companySecrets,
      client: mockClient(vi.fn().mockResolvedValue(
        taskData({
          status: 1,
          name: 'Clock(time)',
          data: '2026-08-05 00:00:00',
        }),
      )),
    });

    const event = await incoming.fetchStatus!(
      baseMessage({ commandType: 'READ_DATE' }),
    );
    expect(event?.response?.data).toEqual({
      year: 2026,
      month: 8,
      day: 5,
    });
  });

  it('maps SET_DATE Clock(time) to dateAccepted', async () => {
    const incoming = createCalinApiV2Incoming({
      secrets: companySecrets,
      client: mockClient(vi.fn().mockResolvedValue(
        taskData({
          status: 1,
          name: 'Clock(time)',
          data: '',
        }),
      )),
    });

    const event = await incoming.fetchStatus!(
      baseMessage({ commandType: 'SET_DATE' }),
    );
    expect(event?.response?.data).toEqual({ dateAccepted: true });
  });

  it('maps Relay On/Off Connected to turnOnAccepted', async () => {
    const incoming = createCalinApiV2Incoming({
      secrets: companySecrets,
      client: mockClient(vi.fn().mockResolvedValue(
        taskData({
          status: 1,
          name: 'Relay On/Off',
          data: 'Connected',
        }),
      )),
    });

    const event = await incoming.fetchStatus!(
      baseMessage({ commandType: 'TURN_ON' }),
    );
    expect(event?.response?.data).toEqual({ turnOnAccepted: true });
  });

  it('maps Relay On/Off Disconnected to turnOffAccepted', async () => {
    const incoming = createCalinApiV2Incoming({
      secrets: companySecrets,
      client: mockClient(vi.fn().mockResolvedValue(
        taskData({
          status: 1,
          name: 'Relay On/Off',
          data: 'Disconnected',
        }),
      )),
    });

    const event = await incoming.fetchStatus!(
      baseMessage({ commandType: 'TURN_OFF' }),
    );
    expect(event?.response?.data).toEqual({ turnOffAccepted: true });
  });

  it('maps unrecognized Relay On/Off data to turnOffAccepted', async () => {
    const incoming = createCalinApiV2Incoming({
      secrets: companySecrets,
      client: mockClient(vi.fn().mockResolvedValue(
        taskData({
          status: 1,
          name: 'Relay On/Off',
          data: 'unknown-state',
        }),
      )),
    });

    const event = await incoming.fetchStatus!(
      baseMessage({ commandType: 'TURN_OFF' }),
    );
    expect(event?.response?.data).toEqual({ turnOffAccepted: true });
  });

  it('maps status 2 to EXECUTION_FAILURE', async () => {
    const incoming = createCalinApiV2Incoming({
      secrets: companySecrets,
      client: mockClient(vi.fn().mockResolvedValue(taskData({ status: 2 }))),
    });

    await expect(
      incoming.fetchStatus!(baseMessage({ commandType: 'SET_DATE' })),
    ).resolves.toMatchObject({
      deliveryStatus: 'DELIVERY_SUCCESSFUL',
      response: { status: 'EXECUTION_FAILURE' },
      failureContext: {
        reason: 'Delivery was successful but execution of the command failed',
      },
    });
  });

  it('maps status 3 (token rejected) to skipRetry failure', async () => {
    const incoming = createCalinApiV2Incoming({
      secrets: companySecrets,
      client: mockClient(vi.fn().mockResolvedValue(
        taskData({ status: 3, name: 'Token', data: '' }),
      )),
    });

    await expect(
      incoming.fetchStatus!(baseMessage({
        commandType: 'TOP_UP_KWH',
        requestData: { token: 'tok' },
      })),
    ).resolves.toMatchObject({
      deliveryStatus: 'DELIVERY_SUCCESSFUL',
      response: { status: 'EXECUTION_FAILURE' },
      failureContext: {
        reason: 'The token was rejected, possibly already delivered',
        skipRetry: true,
      },
    });
  });

  it('maps transport errors to DELIVERY_FAILED', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const incoming = createCalinApiV2Incoming({
      secrets: companySecrets,
      client: mockClient(vi.fn().mockRejectedValue(
        new CalinApiV2Error('CALIN API-V2 is down'),
      )),
    });

    await expect(
      incoming.fetchStatus!(baseMessage({ commandType: 'READ_VERSION' })),
    ).resolves.toEqual({
      deliveryQueueId: '3800',
      commandType: 'READ_VERSION',
      device: { type: 'ELECTRICITY_METER', externalReference: 'm-1' },
      deliveryStatus: 'DELIVERY_FAILED',
      failureContext: {
        reason: 'Could not check task status because CALIN API-V2 is down',
        errorCode: undefined,
      },
    });
  });

  it('posts GetTokenTask for token commands', async () => {
    const sendRequest = vi.fn().mockResolvedValue(
      taskData({ status: 1, name: 'Token', data: '' }),
    );
    const incoming = createCalinApiV2Incoming({
      secrets: companySecrets,
      client: mockClient(sendRequest),
    });

    await expect(
      incoming.fetchStatus!(baseMessage({
        commandType: 'DELIVER_PREEXISTING_TOKEN',
        requestData: { token: 'tok' },
      })),
    ).resolves.toMatchObject({
      response: {
        status: 'EXECUTION_SUCCESS',
        data: { tokenAccepted: true },
      },
    });
    expect(sendRequest).toHaveBeenCalledWith(
      '/API/RemoteMeterTask/GetTokenTask',
      expect.objectContaining({ id: 3800 }),
    );
  });
});
