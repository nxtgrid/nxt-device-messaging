import { describe, expect, it, vi } from 'vitest';

import type { DeviceMessage } from '#src/lib/device-message/types.js';
import { createCalinApiV1Incoming } from '#src/plugins/calin-api-v1/incoming.js';
import {
  CalinApiV1Error,
  type CalinApiV1Client,
  type CalinApiV1CommResponse,
  type CalinApiV1DataItem,
} from '#src/plugins/calin-api-v1/lib/repo.js';

const adminSecrets = {
  companyName: 'Acme',
  adminUsername: 'admin',
  adminPassword: 'secret',
} as const;

function baseMessage(
  overrides: Partial<DeviceMessage> & Pick<DeviceMessage, 'commandType'>,
): DeviceMessage {
  return {
    id: 'msg-1',
    priority: 0,
    pluginId: 'calin-api-v1',
    networkId: 1,
    deliveryQueueId: 'task-1',
    deliveryStatus: 'SENT_TO_NS',
    device: { type: 'ELECTRICITY_METER', externalReference: 'm-1' },
    ...overrides,
  };
}

function mockClient(
  sendRequest: CalinApiV1Client['sendRequest'],
): CalinApiV1Client {
  return { sendRequest };
}

function commResult(opts: {
  status: 'True' | 'False' | 'unknown' | null;
  dataItem?: CalinApiV1DataItem;
  data?: string;
  resultCode?: CalinApiV1CommResponse['ResultCode'];
  reason?: CalinApiV1CommResponse['Reason'];
}): CalinApiV1CommResponse {
  return {
    ResultCode: opts.resultCode ?? '00',
    Reason: opts.reason ?? 'OK',
    Result: {
      TaskNo: 'task-1',
      Status: opts.status,
      DataItem: opts.dataItem ?? 'Current Credit Register',
      Data: opts.data ?? '',
    },
  };
}

describe('createCalinApiV1Incoming', () => {
  it('fetchStatus polls the task path for the command family', async () => {
    const sendRequest = vi.fn().mockResolvedValue(
      commResult({ status: null }),
    );
    const incoming = createCalinApiV1Incoming({
      secrets: adminSecrets,
      client: mockClient(sendRequest),
    });

    await expect(
      incoming.fetchStatus!(baseMessage({ commandType: 'READ_CREDIT' })),
    ).resolves.toBeNull();

    expect(sendRequest).toHaveBeenCalledWith('/COMM_RemoteReadingTask', {
      CompanyName: 'Acme',
      UserName: 'admin',
      Password: 'secret',
      TaskNo: 'task-1',
    });
  });

  it('returns null while Status is unknown / null', async () => {
    const incoming = createCalinApiV1Incoming({
      secrets: adminSecrets,
      client: mockClient(vi.fn().mockResolvedValue(
        commResult({ status: 'unknown' }),
      )),
    });

    await expect(
      incoming.fetchStatus!(baseMessage({ commandType: 'TURN_ON' })),
    ).resolves.toBeNull();
  });

  it('parses READ_CREDIT success with camelCase response.data', async () => {
    const incoming = createCalinApiV1Incoming({
      secrets: adminSecrets,
      client: mockClient(vi.fn().mockResolvedValue(
        commResult({
          status: 'True',
          dataItem: 'Current Credit Register',
          data: '12.5,ON',
        }),
      )),
    });

    await expect(
      incoming.fetchStatus!(baseMessage({ commandType: 'READ_CREDIT' })),
    ).resolves.toEqual({
      deliveryQueueId: 'task-1',
      commandType: 'READ_CREDIT',
      device: { type: 'ELECTRICITY_METER', externalReference: 'm-1' },
      deliveryStatus: 'DELIVERY_SUCCESSFUL',
      response: {
        status: 'EXECUTION_SUCCESS',
        data: { kwhCreditAvailable: 12.5, isOn: true },
      },
    });
  });

  it('parses phase voltage DataItem into response.data.phase', async () => {
    const incoming = createCalinApiV1Incoming({
      secrets: adminSecrets,
      client: mockClient(vi.fn().mockResolvedValue(
        commResult({
          status: 'True',
          dataItem: 'VoltageB',
          data: '230.1 V',
        }),
      )),
    });

    const event = await incoming.fetchStatus!(
      baseMessage({ commandType: 'READ_VOLTAGE', phase: 'B' }),
    );
    expect(event?.response).toEqual({
      status: 'EXECUTION_SUCCESS',
      data: { voltage: 230.1, phase: 'B' },
    });
  });

  it('uses camelCase powerLimit for Maximum power threshold', async () => {
    const incoming = createCalinApiV1Incoming({
      secrets: adminSecrets,
      client: mockClient(vi.fn().mockResolvedValue(
        commResult({
          status: 'True',
          dataItem: 'Maximum power threshold',
          data: '5000 W',
        }),
      )),
    });

    const event = await incoming.fetchStatus!(
      baseMessage({ commandType: 'READ_POWER_LIMIT' }),
    );
    expect(event?.response?.data).toEqual({ powerLimit: 5000 });
  });

  it('maps Status False to EXECUTION_FAILURE', async () => {
    const incoming = createCalinApiV1Incoming({
      secrets: adminSecrets,
      client: mockClient(vi.fn().mockResolvedValue(
        commResult({ status: 'False' }),
      )),
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

  it('maps ResultCode 99 with no Result to skipRetry failure', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const incoming = createCalinApiV1Incoming({
      secrets: adminSecrets,
      client: mockClient(vi.fn().mockResolvedValue({
        ResultCode: '99',
        Reason: 'other error',
      } satisfies CalinApiV1CommResponse)),
    });

    await expect(
      incoming.fetchStatus!(baseMessage({
        commandType: 'TOP_UP_KWH',
        requestData: { token: 'tok' },
      })),
    ).resolves.toMatchObject({
      deliveryStatus: 'DELIVERY_FAILED',
      failureContext: {
        reason: 'The token was rejected, possibly already delivered.',
        errorCode: 99,
        skipRetry: true,
      },
    });
  });

  it('maps transport errors to DELIVERY_FAILED', async () => {
    const incoming = createCalinApiV1Incoming({
      secrets: adminSecrets,
      client: mockClient(vi.fn().mockRejectedValue(
        new CalinApiV1Error('[CALIN API-V1] is down', 'ECONNRESET'),
      )),
    });

    await expect(
      incoming.fetchStatus!(baseMessage({ commandType: 'READ_VERSION' })),
    ).resolves.toEqual({
      deliveryQueueId: 'task-1',
      commandType: 'READ_VERSION',
      device: { type: 'ELECTRICITY_METER', externalReference: 'm-1' },
      deliveryStatus: 'DELIVERY_FAILED',
      failureContext: {
        reason: 'Could not check task status because [CALIN API-V1] is down',
        errorCode: 'ECONNRESET',
      },
    });
  });

  it('posts TOKEN task path for token commands', async () => {
    const sendRequest = vi.fn().mockResolvedValue(
      commResult({
        status: 'True',
        dataItem: 'Token',
        data: '',
      }),
    );
    const incoming = createCalinApiV1Incoming({
      secrets: adminSecrets,
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
      '/COMM_RemoteTokenTask',
      expect.objectContaining({ TaskNo: 'task-1' }),
    );
  });
});
