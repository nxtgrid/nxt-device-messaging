import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCalinChirpstackIncoming } from '#src/plugins/calin-chirpstack/incoming.js';
import { eventCorrelator } from '#src/plugins/calin-chirpstack/lib/correlate-request-response.js';

afterEach(() => {
  eventCorrelator.clear();
  vi.restoreAllMocks();
});

const DEV_EUI = '0000047003333771';
const METER_REF = DEV_EUI.substring(5); // '047003333771'

describe('createCalinChirpstackIncoming', () => {
  const incoming = createCalinChirpstackIncoming();

  it('returns null for non-objects / missing deviceInfo', () => {
    expect(incoming.handle?.(null)).toBeNull();
    expect(incoming.handle?.({})).toBeNull();
    expect(incoming.handle?.({ deviceInfo: {} })).toBeNull();
  });

  it('handleDown maps tx-ack to SENT_TO_DEVICE', () => {
    expect(incoming.handle?.({
      downlinkId: 'dl-1',
      queueItemId: 'q-1',
      deviceInfo: { devEui: DEV_EUI },
    })).toEqual({
      deliveryQueueId: 'q-1',
      deliveryStatus: 'SENT_TO_DEVICE',
      device: {
        type: 'ELECTRICITY_METER',
        externalReference: METER_REF,
      },
    });
  });

  it('handleJoin emits unsolicited JOIN_NETWORK', () => {
    expect(incoming.handle?.({
      deduplicationId: 'd-join',
      deviceInfo: { devEui: DEV_EUI },
      devAddr: '01020304',
    })).toEqual({
      deliveryStatus: 'DELIVERY_SUCCESSFUL',
      commandType: 'JOIN_NETWORK',
      response: {
        data: { networkJoined: true },
        status: 'EXECUTION_SUCCESS',
      },
      device: {
        type: 'ELECTRICITY_METER',
        externalReference: METER_REF,
      },
      unsolicited: true,
    });
  });

  it('handleAck failure returns DELIVERY_FAILED with skip-worthy reason', () => {
    expect(incoming.handle?.({
      queueItemId: 'q-fail',
      deduplicationId: 'd-fail',
      deviceInfo: { devEui: DEV_EUI },
      acknowledged: false,
    })).toMatchObject({
      deliveryQueueId: 'q-fail',
      deliveryStatus: 'DELIVERY_FAILED',
      failureContext: {
        reason: expect.stringContaining('not acknowledged'),
      },
      device: {
        type: 'ELECTRICITY_METER',
        externalReference: METER_REF,
      },
    });
  });

  it('correlates ACK then UP into DELIVERY_SUCCESSFUL', () => {
    expect(incoming.handle?.({
      queueItemId: 'q-1',
      deduplicationId: 'd-1',
      deviceInfo: { devEui: DEV_EUI },
      acknowledged: true,
    })).toBeNull();

    // Token-failure fixture from decode tests (always-decodable CALIN frame)
    const combined = incoming.handle?.({
      deduplicationId: 'd-1',
      deviceInfo: { devEui: DEV_EUI },
      devAddr: 'addr',
      rxInfo: [
        { gatewayId: 'gw-1', snr: 8, rssi: -95 },
      ],
      data: 'aCM2MwNwBGjAATTIFg==',
    });

    expect(combined).toMatchObject({
      deliveryQueueId: 'q-1',
      deliveryStatus: 'DELIVERY_SUCCESSFUL',
      response: {
        status: 'EXECUTION_FAILURE',
        data: { tokenAccepted: false },
      },
      device: {
        type: 'ELECTRICITY_METER',
        externalReference: METER_REF,
        relayNode: {
          externalReference: 'gw-1',
          snr: 8,
          rssi: -95,
        },
      },
    });
  });

  it('returns null when uplink frame cannot be decoded', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(incoming.handle?.({
      deduplicationId: 'd-bad',
      deviceInfo: { devEui: DEV_EUI },
      devAddr: 'addr',
      rxInfo: [],
      data: Buffer.from([ 0x11, 0x22, 0x33, 0x16 ]).toString('base64'),
    })).toBeNull();
  });
});
