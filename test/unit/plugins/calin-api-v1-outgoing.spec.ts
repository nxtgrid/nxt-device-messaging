import { describe, expect, it, vi } from 'vitest';

import type { DeviceMessage } from '#src/lib/device-message/types.js';
import {
  CalinApiV1Error,
  type CalinApiV1Client,
  type CalinApiV1CommResponse,
} from '#src/plugins/calin-api-v1/lib/repo.js';
import { createCalinApiV1Outgoing } from '#src/plugins/calin-api-v1/outgoing.js';

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
    deliveryQueueId: '',
    deliveryStatus: 'QUEUED',
    device: { type: 'ELECTRICITY_METER', externalReference: 'm-1' },
    ...overrides,
  };
}

function mockClient(
  sendRequest: CalinApiV1Client['sendRequest'],
): CalinApiV1Client {
  return { sendRequest };
}

function okComm(taskNo: string): CalinApiV1CommResponse {
  return {
    ResultCode: '00',
    Reason: 'OK',
    Result: {
      TaskNo: taskNo,
      Status: null,
      DataItem: 'Current Credit Register',
      Data: '',
    },
  };
}

describe('createCalinApiV1Outgoing', () => {
  it('sendOne READ posts COMM_RemoteReading with admin creds', async () => {
    const sendRequest = vi.fn().mockResolvedValue(okComm('task-read'));
    const outgoing = createCalinApiV1Outgoing({
      secrets: adminSecrets,
      client: mockClient(sendRequest),
    });

    await expect(
      outgoing.sendOne(baseMessage({ commandType: 'READ_CREDIT' })),
    ).resolves.toBe('task-read');

    expect(sendRequest).toHaveBeenCalledWith('/COMM_RemoteReading', {
      CompanyName: 'Acme',
      UserName: 'admin',
      Password: 'secret',
      MeterNo: 'm-1',
      DataItem: 'Current Credit Register',
    });
  });

  it('sendOne READ_VOLTAGE with phase uses phase DataItem', async () => {
    const sendRequest = vi.fn().mockResolvedValue(okComm('task-phase'));
    const outgoing = createCalinApiV1Outgoing({
      secrets: adminSecrets,
      client: mockClient(sendRequest),
    });

    await outgoing.sendOne(
      baseMessage({ commandType: 'READ_VOLTAGE', phase: 'B' }),
    );

    expect(sendRequest).toHaveBeenCalledWith(
      '/COMM_RemoteReading',
      expect.objectContaining({ DataItem: 'VoltageB' }),
    );
  });

  it('sendOne TURN_OFF posts COMM_RemoteControl', async () => {
    const sendRequest = vi.fn().mockResolvedValue(okComm('task-ctrl'));
    const outgoing = createCalinApiV1Outgoing({
      secrets: adminSecrets,
      client: mockClient(sendRequest),
    });

    await expect(
      outgoing.sendOne(baseMessage({ commandType: 'TURN_OFF' })),
    ).resolves.toBe('task-ctrl');

    expect(sendRequest).toHaveBeenCalledWith(
      '/COMM_RemoteControl',
      expect.objectContaining({ DataItem: 'Switch Off' }),
    );
  });

  it('sendOne SET_DATE posts COMM_RemoteWrite with formatted Data', async () => {
    const sendRequest = vi.fn().mockResolvedValue(okComm('task-write'));
    const outgoing = createCalinApiV1Outgoing({
      secrets: adminSecrets,
      client: mockClient(sendRequest),
    });

    // 2026-08-05 is a Wednesday → weekday 3 → yymmddww
    await outgoing.sendOne(baseMessage({
      commandType: 'SET_DATE',
      requestData: { payload: { year: 2026, month: 8, day: 5 } },
    }));

    expect(sendRequest).toHaveBeenCalledWith(
      '/COMM_RemoteWrite',
      expect.objectContaining({
        DataItem: 'Date',
        Data: '26080503',
      }),
    );

    // 2-digit years normalize to 20xx (same calendar weekday)
    sendRequest.mockClear();
    await outgoing.sendOne(baseMessage({
      commandType: 'SET_DATE',
      requestData: { payload: { year: 26, month: 8, day: 5 } },
    }));
    expect(sendRequest).toHaveBeenCalledWith(
      '/COMM_RemoteWrite',
      expect.objectContaining({ Data: '26080503' }),
    );
  });

  it('sendOne SET_DATE rejects non-existent calendar dates', async () => {
    const sendRequest = vi.fn();
    const outgoing = createCalinApiV1Outgoing({
      secrets: adminSecrets,
      client: mockClient(sendRequest),
    });

    await expect(
      outgoing.sendOne(baseMessage({
        commandType: 'SET_DATE',
        requestData: { payload: { year: 2026, month: 2, day: 30 } },
      })),
    ).rejects.toMatchObject({
      name: 'CalinApiV1Error',
      message: 'Invalid payload for setting date',
      skipRetry: true,
    });

    expect(sendRequest).not.toHaveBeenCalled();
  });

  it('sendOne token commands reject missing / blank token', async () => {
    const outgoing = createCalinApiV1Outgoing({
      secrets: adminSecrets,
      client: mockClient(vi.fn()),
    });

    await expect(
      outgoing.sendOne(baseMessage({ commandType: 'TOP_UP_KWH' })),
    ).rejects.toMatchObject({
      name: 'CalinApiV1Error',
      message: expect.stringMatching(/without a token/),
      skipRetry: true,
    });

    await expect(
      outgoing.sendOne(baseMessage({
        commandType: 'TOP_UP_KWH',
        requestData: { token: '   ' },
      })),
    ).rejects.toMatchObject({
      name: 'CalinApiV1Error',
      skipRetry: true,
    });
  });

  it('sendOne TOP_UP_KWH posts COMM_RemoteToken', async () => {
    const sendRequest = vi.fn().mockResolvedValue(okComm('task-token'));
    const outgoing = createCalinApiV1Outgoing({
      secrets: adminSecrets,
      client: mockClient(sendRequest),
    });

    await expect(
      outgoing.sendOne(baseMessage({
        commandType: 'TOP_UP_KWH',
        requestData: { token: 'tok-1' },
      })),
    ).resolves.toBe('task-token');

    expect(sendRequest).toHaveBeenCalledWith(
      '/COMM_RemoteToken',
      expect.objectContaining({ Token: 'tok-1', MeterNo: 'm-1' }),
    );
  });

  it('throws CalinApiV1Error when Result.TaskNo is missing', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ResultCode: '00',
      Reason: 'other error',
    } satisfies CalinApiV1CommResponse);
    const outgoing = createCalinApiV1Outgoing({
      secrets: adminSecrets,
      client: mockClient(sendRequest),
    });

    await expect(
      outgoing.sendOne(baseMessage({ commandType: 'READ_CREDIT' })),
    ).rejects.toMatchObject({
      name: 'CalinApiV1Error',
      message: /did not schedule task because: other error/,
      code: 0,
    });
  });

  it('throws a specific error when token is immediately rejected (99)', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ResultCode: '99',
      Reason: 'other error',
    } satisfies CalinApiV1CommResponse);
    const outgoing = createCalinApiV1Outgoing({
      secrets: adminSecrets,
      client: mockClient(sendRequest),
    });

    await expect(
      outgoing.sendOne(baseMessage({
        commandType: 'DELIVER_PREEXISTING_TOKEN',
        requestData: { token: 'tok-x' },
      })),
    ).rejects.toMatchObject({
      message: /Token tok-x was immediately rejected for meter m-1/,
      code: 99,
    });
  });

  it('does not treat Object.prototype keys as read commands', async () => {
    const sendRequest = vi.fn();
    const outgoing = createCalinApiV1Outgoing({
      secrets: adminSecrets,
      client: mockClient(sendRequest),
    });

    // `constructor` is `in` the map via the prototype chain, but not an own key.
    await expect(
      outgoing.sendOne(baseMessage({
        commandType: 'constructor' as DeviceMessage['commandType'],
      })),
    ).rejects.toMatchObject({
      name: 'CalinApiV1Error',
      message: 'Not implemented',
      skipRetry: true,
    });
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it('parseError maps CalinApiV1Error including skipRetry for code 99', () => {
    const outgoing = createCalinApiV1Outgoing({
      secrets: adminSecrets,
      client: mockClient(vi.fn()),
    });

    expect(outgoing.parseError(new CalinApiV1Error('boom', { code: 99 }))).toEqual({
      reason: 'boom',
      errorCode: 99,
      skipRetry: true,
    });
    expect(outgoing.parseError(new CalinApiV1Error('tmp', { code: 'ECONNRESET' }))).toEqual({
      reason: 'tmp',
      errorCode: 'ECONNRESET',
      skipRetry: false,
    });
    expect(outgoing.parseError(
      new CalinApiV1Error('bad payload', { skipRetry: true }),
    )).toEqual({
      reason: 'bad payload',
      errorCode: undefined,
      skipRetry: true,
    });
    expect(outgoing.parseError(new Error('plain'))).toEqual({
      reason: 'plain',
    });
  });
});
