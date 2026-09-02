import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCalinChirpstackIncoming } from '#src/plugins/calin-chirpstack/incoming.js';
import { eventCorrelator } from '#src/plugins/calin-chirpstack/lib/correlate-request-response.js';
import type { IncomingHandleMeta } from '#src/plugins/plugin.interface.js';

afterEach(() => {
  eventCorrelator.clear();
  vi.restoreAllMocks();
});

const DEV_EUI = '0000047003333771';
/** 11-digit meter serial after stripping 5 leading DevEUI pad digits. */
const METER_REF = '47003333771';

const meta = (event: string): IncomingHandleMeta => ({ query: { event } });

describe('createCalinChirpstackIncoming', () => {
  const incoming = createCalinChirpstackIncoming();

  it('returns null for non-objects / missing deviceInfo', () => {
    expect(incoming.handle?.(null, meta('txack'))).toBeNull();
    expect(incoming.handle?.({}, meta('txack'))).toBeNull();
    expect(incoming.handle?.({ deviceInfo: {} }, meta('txack'))).toBeNull();
  });

  it('returns null when DevEUI is not 16 hex digits', () => {
    expect(incoming.handle?.({
      downlinkId: 'dl-1',
      queueItemId: 'q-1',
      deviceInfo: { devEui: '47003333771' },
    }, meta('txack'))).toBeNull();
  });

  it('returns null when ?event= is missing or unhandled', () => {
    const body = {
      downlinkId: 'dl-1',
      queueItemId: 'q-1',
      deviceInfo: { devEui: DEV_EUI },
    };
    expect(incoming.handle?.(body)).toBeNull();
    expect(incoming.handle?.(body, { query: {} })).toBeNull();
    expect(incoming.handle?.(body, meta('status'))).toBeNull();
    expect(incoming.handle?.(body, meta('log'))).toBeNull();
  });

  it('handleDown maps txack to SENT_TO_DEVICE', () => {
    expect(incoming.handle?.({
      downlinkId: 'dl-1',
      queueItemId: 'q-1',
      deviceInfo: { devEui: DEV_EUI },
    }, meta('txack'))).toEqual({
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
    }, meta('join'))).toEqual({
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
    }, meta('ack'))).toMatchObject({
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
    }, meta('ack'))).toBeNull();

    // Token-failure fixture from decode tests (always-decodable CALIN frame)
    const combined = incoming.handle?.({
      deduplicationId: 'd-1',
      deviceInfo: { devEui: DEV_EUI },
      devAddr: 'addr',
      rxInfo: [
        { gatewayId: 'gw-1', snr: 8, rssi: -95 },
      ],
      data: 'aCM2MwNwBGjAATTIFg==',
    }, meta('up'));

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
    expect(incoming.handle?.({
      deduplicationId: 'd-bad',
      deviceInfo: { devEui: DEV_EUI },
      devAddr: 'addr',
      rxInfo: [],
      data: Buffer.from([ 0x11, 0x22, 0x33, 0x16 ]).toString('base64'),
    }, meta('up'))).toBeNull();
  });

  it('returns null for txack without downlinkId', () => {
    expect(incoming.handle?.({
      queueItemId: 'q-1',
      deviceInfo: { devEui: DEV_EUI },
    }, meta('txack'))).toBeNull();
  });

  it('returns null for ack without boolean acknowledged', () => {
    expect(incoming.handle?.({
      queueItemId: 'q-1',
      deduplicationId: 'd-1',
      deviceInfo: { devEui: DEV_EUI },
    }, meta('ack'))).toBeNull();
  });

  it('returns null for up without data or rxInfo array', () => {
    const base = {
      deduplicationId: 'd-1',
      deviceInfo: { devEui: DEV_EUI },
      devAddr: 'addr',
    };
    expect(incoming.handle?.({
      ...base,
      rxInfo: [],
    }, meta('up'))).toBeNull();
    expect(incoming.handle?.({
      ...base,
      data: 'aCM2MwNwBGjAATTIFg==',
    }, meta('up'))).toBeNull();
  });

  it('verifySignature is open when no ingress key is configured', () => {
    expect(incoming.verifySignature?.(Buffer.from('{}'), {})).toBe(true);
    expect(incoming.verifySignature?.(Buffer.from('{}'), {
      'x-api-key': 'anything',
    })).toBe(true);
  });

  it('verifySignature requires X-API-KEY when an ingress key is set', () => {
    const guarded = createCalinChirpstackIncoming({ ingressApiKey: 'secret-key' });
    expect(guarded.verifySignature?.(Buffer.from('{}'), {
      'x-api-key': 'secret-key',
    })).toBe(true);
    expect(guarded.verifySignature?.(Buffer.from('{}'), {
      'x-api-key': 'wrong-key',
    })).toBe(false);
    expect(guarded.verifySignature?.(Buffer.from('{}'), {})).toBe(false);
  });
});
