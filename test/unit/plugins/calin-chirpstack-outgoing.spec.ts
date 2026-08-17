import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DeviceMessage } from '#src/lib/device-message/types.js';
import type { ChirpstackClient } from '#src/plugins/_shared/chirpstack-repository/index.js';
import {
  CalinChirpstackError,
  createCalinChirpstackOutgoing,
} from '#src/plugins/calin-chirpstack/outgoing.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function baseMessage(
  overrides: Partial<DeviceMessage> & Pick<DeviceMessage, 'commandType'>,
): DeviceMessage {
  return {
    id: 'msg-1',
    priority: 0,
    pluginId: 'calin-chirpstack',
    networkId: 1,
    deliveryQueueId: 'queue-item-1',
    deliveryStatus: 'SENT_TO_DEVICE',
    device: { type: 'ELECTRICITY_METER', externalReference: '47003333771' },
    ...overrides,
  };
}

function mockClient(
  overrides: Partial<ChirpstackClient> = {},
): ChirpstackClient {
  return {
    enqueueDeviceRequest: vi.fn().mockResolvedValue('queue-item-new'),
    getDeviceQueue: vi.fn().mockResolvedValue([]),
    registerDevice: vi.fn(),
    setApplicationKeyForDevice: vi.fn(),
    ...overrides,
  };
}

describe('createCalinChirpstackOutgoing', () => {
  it('sendOne encodes and enqueues with 16-digit DevEUI', async () => {
    const client = mockClient();
    const outgoing = createCalinChirpstackOutgoing({ client });

    await expect(
      outgoing.sendOne(baseMessage({ commandType: 'READ_CREDIT' })),
    ).resolves.toBe('queue-item-new');

    expect(client.enqueueDeviceRequest).toHaveBeenCalledOnce();
    const [ deviceEui, bytes ] = vi.mocked(client.enqueueDeviceRequest).mock.calls[0]!;
    expect(deviceEui).toBe('0000047003333771');
    expect(bytes[0]).toBe(0x68);
    expect(bytes[bytes.length - 1]).toBe(0x16);
  });

  it('sendOne delivers token commands when token is present', async () => {
    const client = mockClient();
    const outgoing = createCalinChirpstackOutgoing({ client });

    await expect(
      outgoing.sendOne(baseMessage({
        commandType: 'TOP_UP_KWH',
        requestData: { token: 'AABBCCDD' },
      })),
    ).resolves.toBe('queue-item-new');

    expect(client.enqueueDeviceRequest).toHaveBeenCalledOnce();
  });

  it('sendOne throws CalinChirpstackError(skipRetry) when encode fails', async () => {
    const client = mockClient();
    const outgoing = createCalinChirpstackOutgoing({ client });

    await expect(
      outgoing.sendOne(baseMessage({ commandType: 'READ_VERSION' })),
    ).rejects.toMatchObject({
      name: 'CalinChirpstackError',
      skipRetry: true,
    });
    expect(client.enqueueDeviceRequest).not.toHaveBeenCalled();
  });

  it('getRemoteStatus keeps status while queue item is still present', async () => {
    const client = mockClient({
      getDeviceQueue: vi.fn().mockResolvedValue([
        { deliveryQueueId: 'queue-item-1' },
      ]),
    });
    const outgoing = createCalinChirpstackOutgoing({ client });

    await expect(
      outgoing.getRemoteStatus?.(baseMessage({ commandType: 'READ_CREDIT' })),
    ).resolves.toEqual({ deliveryStatus: 'SENT_TO_DEVICE' });
  });

  it('getRemoteStatus returns DELIVERY_FAILED when queue item is gone', async () => {
    const client = mockClient({
      getDeviceQueue: vi.fn().mockResolvedValue([
        { deliveryQueueId: 'other-item' },
      ]),
    });
    const outgoing = createCalinChirpstackOutgoing({ client });

    await expect(
      outgoing.getRemoteStatus?.(baseMessage({ commandType: 'READ_CREDIT' })),
    ).resolves.toEqual({ deliveryStatus: 'DELIVERY_FAILED' });
  });

  it('parseError sets skipRetry for unregistered-device FK violation', () => {
    const outgoing = createCalinChirpstackOutgoing({ client: mockClient() });

    expect(outgoing.parseError({
      code: 3,
      details: 'insert … device_queue_item_dev_eui_fkey …',
    })).toEqual({
      reason: 'Device not registered in Network Server (ChirpStack)',
      errorCode: 3,
      details: 'insert … device_queue_item_dev_eui_fkey …',
      skipRetry: true,
    });
  });

  it('parseError sets skipRetry for CalinChirpstackError', () => {
    const outgoing = createCalinChirpstackOutgoing({ client: mockClient() });
    expect(outgoing.parseError(
      new CalinChirpstackError('encode failed', { skipRetry: true }),
    )).toEqual({
      reason: 'encode failed',
      skipRetry: true,
    });
  });

  it('parseError falls back for unknown gRPC errors', () => {
    const outgoing = createCalinChirpstackOutgoing({ client: mockClient() });

    expect(outgoing.parseError({
      code: 14,
      details: 'unavailable',
    })).toEqual({
      reason: 'Failed to enqueue message at ChirpStack',
      errorCode: 14,
      details: 'unavailable',
    });
  });

  it('parseError does not throw on nullish err', () => {
    const outgoing = createCalinChirpstackOutgoing({ client: mockClient() });

    expect(outgoing.parseError(null)).toEqual({
      reason: 'Failed to enqueue message at ChirpStack',
      errorCode: undefined,
      details: undefined,
    });
  });
});
