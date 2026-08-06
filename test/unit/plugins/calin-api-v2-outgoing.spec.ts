import { describe, expect, it, vi } from 'vitest';

import type { DeviceMessage } from '#src/lib/device-message/types.js';
import {
  CalinApiV2Error,
  type CalinApiV2Client,
  type CalinApiV2CreateTaskResponse,
} from '#src/plugins/calin-api-v2/lib/repo.js';
import { createCalinApiV2Outgoing } from '#src/plugins/calin-api-v2/outgoing.js';

const taskSecrets = {
  companyName: 'Acme',
  customerId: 'cust-1',
} as const;

function baseMessage(
  overrides: Partial<DeviceMessage> & Pick<DeviceMessage, 'commandType'>,
): DeviceMessage {
  return {
    id: 'msg-1',
    priority: 0,
    pluginId: 'calin-api-v2',
    networkId: 1,
    deliveryQueueId: '',
    deliveryStatus: 'QUEUED',
    device: { type: 'ELECTRICITY_METER', externalReference: 'm-1' },
    ...overrides,
  };
}

function mockClient(
  sendRequest: CalinApiV2Client['sendRequest'],
): CalinApiV2Client {
  return { sendRequest };
}

function okCreate(taskId: string): CalinApiV2CreateTaskResponse {
  return {
    code: 0,
    reason: 'success',
    result: [ { id: taskId } ],
  };
}

describe('createCalinApiV2Outgoing', () => {
  it('sendOne READ posts CreateReadingTask with protocolId', async () => {
    const sendRequest = vi.fn().mockResolvedValue(okCreate('task-read'));
    const outgoing = createCalinApiV2Outgoing({
      secrets: taskSecrets,
      client: mockClient(sendRequest),
    });

    await expect(
      outgoing.sendOne(baseMessage({ commandType: 'READ_CREDIT' })),
    ).resolves.toBe('task-read');

    expect(sendRequest).toHaveBeenCalledWith(
      '/API/RemoteMeterTask/CreateReadingTask',
      [ {
        meterId: 'm-1',
        protocolId: 39,
        customerId: 'cust-1',
        company: 'Acme',
      } ],
    );
  });

  it('sendOne TURN_OFF posts CreateControlTask', async () => {
    const sendRequest = vi.fn().mockResolvedValue(okCreate('task-ctrl'));
    const outgoing = createCalinApiV2Outgoing({
      secrets: taskSecrets,
      client: mockClient(sendRequest),
    });

    await expect(
      outgoing.sendOne(baseMessage({ commandType: 'TURN_OFF' })),
    ).resolves.toBe('task-ctrl');

    expect(sendRequest).toHaveBeenCalledWith(
      '/API/RemoteMeterTask/CreateControlTask',
      [ {
        meterId: 'm-1',
        protocolId: 20001,
        customerId: 'cust-1',
        company: 'Acme',
      } ],
    );
  });

  it('sendOne SET_DATE posts CreateSettingTask with formatted data', async () => {
    const sendRequest = vi.fn().mockResolvedValue(okCreate('task-write'));
    const outgoing = createCalinApiV2Outgoing({
      secrets: taskSecrets,
      client: mockClient(sendRequest),
    });

    await outgoing.sendOne(baseMessage({
      commandType: 'SET_DATE',
      requestData: { payload: { year: 2026, month: 8, day: 5 } },
    }));

    expect(sendRequest).toHaveBeenCalledWith(
      '/API/RemoteMeterTask/CreateSettingTask',
      [ {
        meterId: 'm-1',
        protocolId: 10000,
        data: '2026-08-05 00:00:00',
        customerId: 'cust-1',
        company: 'Acme',
      } ],
    );

    sendRequest.mockClear();
    await outgoing.sendOne(baseMessage({
      commandType: 'SET_DATE',
      requestData: { payload: { year: 26, month: 8, day: 5 } },
    }));
    expect(sendRequest).toHaveBeenCalledWith(
      '/API/RemoteMeterTask/CreateSettingTask',
      expect.arrayContaining([
        expect.objectContaining({ data: '2026-08-05 00:00:00' }),
      ]),
    );
  });

  it('sendOne SET_DATE rejects non-existent calendar dates', async () => {
    const sendRequest = vi.fn();
    const outgoing = createCalinApiV2Outgoing({
      secrets: taskSecrets,
      client: mockClient(sendRequest),
    });

    await expect(
      outgoing.sendOne(baseMessage({
        commandType: 'SET_DATE',
        requestData: { payload: { year: 2026, month: 2, day: 30 } },
      })),
    ).rejects.toThrow('Invalid payload for setting date');

    expect(sendRequest).not.toHaveBeenCalled();
  });

  it('sendOne token commands reject missing / blank token', async () => {
    const outgoing = createCalinApiV2Outgoing({
      secrets: taskSecrets,
      client: mockClient(vi.fn()),
    });

    await expect(
      outgoing.sendOne(baseMessage({ commandType: 'TOP_UP_KWH' })),
    ).rejects.toThrow(/without a token/);

    await expect(
      outgoing.sendOne(baseMessage({
        commandType: 'TOP_UP_KWH',
        requestData: { token: '   ' },
      })),
    ).rejects.toThrow(/without a token/);
  });

  it('sendOne TOP_UP_KWH posts CreateTokenTask', async () => {
    const sendRequest = vi.fn().mockResolvedValue(okCreate('task-token'));
    const outgoing = createCalinApiV2Outgoing({
      secrets: taskSecrets,
      client: mockClient(sendRequest),
    });

    await expect(
      outgoing.sendOne(baseMessage({
        commandType: 'TOP_UP_KWH',
        requestData: { token: 'tok-1' },
      })),
    ).resolves.toBe('task-token');

    expect(sendRequest).toHaveBeenCalledWith(
      '/API/RemoteMeterTask/CreateTokenTask',
      [ {
        meterId: 'm-1',
        protocolId: 30000,
        data: 'tok-1',
        customerId: 'cust-1',
        company: 'Acme',
      } ],
    );
  });

  it('throws CalinApiV2Error when result id is missing', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      code: 0,
      reason: 'success',
    } satisfies CalinApiV2CreateTaskResponse);
    const outgoing = createCalinApiV2Outgoing({
      secrets: taskSecrets,
      client: mockClient(sendRequest),
    });

    await expect(
      outgoing.sendOne(baseMessage({ commandType: 'READ_CREDIT' })),
    ).rejects.toMatchObject({
      name: 'CalinApiV2Error',
      message: /did not schedule task because: success/,
    });
  });

  it('parseError maps CalinApiV2Error and plain Error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const outgoing = createCalinApiV2Outgoing({
      secrets: taskSecrets,
      client: mockClient(vi.fn()),
    });

    expect(outgoing.parseError(new CalinApiV2Error('boom', 42))).toEqual({
      reason: 'boom',
      errorCode: 42,
    });
    expect(outgoing.parseError(new Error('plain'))).toEqual({
      reason: 'plain',
    });
  });
});
