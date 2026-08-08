import { afterEach, describe, expect, it, vi } from 'vitest';

import { selectGatewayWithBestSignal } from '#src/plugins/calin-chirpstack/lib/connectivity-helpers.js';
import { eventCorrelator } from '#src/plugins/calin-chirpstack/lib/correlate-request-response.js';
import { decodeResponseData } from '#src/plugins/calin-chirpstack/lib/decode-response-data.js';
import { encodeRequestData } from '#src/plugins/calin-chirpstack/lib/encode-request-data.js';
import { CalinMetaBytes } from '#src/plugins/calin-chirpstack/lib/types.js';

afterEach(() => {
  eventCorrelator.clear();
  vi.useRealTimers();
});

describe('encodeRequestData', () => {
  it('encodes READ_CREDIT with frame markers', () => {
    const bytes = encodeRequestData({
      deviceIdentifier: '47003333771',
      devicePhase: 'A',
      requestType: 'READ_CREDIT',
    });
    expect(bytes).not.toBeNull();
    expect(bytes![0]).toBe(CalinMetaBytes.HEADER_BYTE);
    expect(bytes![bytes!.length - 1]).toBe(CalinMetaBytes.END_BYTE);
    expect(bytes![8]).toBe(0x01); // reading control code
  });

  it('encodes TURN_ON with password write path', () => {
    const bytes = encodeRequestData({
      deviceIdentifier: '47003333771',
      devicePhase: 'A',
      requestType: 'TURN_ON',
    });
    expect(bytes).not.toBeNull();
    expect(bytes![8]).toBe(0x04); // writing control code
  });

  it('returns null for token commands without a token', () => {
    expect(encodeRequestData({
      deviceIdentifier: '47003333771',
      devicePhase: 'A',
      requestType: 'TOP_UP_KWH',
    })).toBeNull();
  });

  it('encodes TOP_UP_KWH when token hex is provided', () => {
    const bytes = encodeRequestData({
      deviceIdentifier: '47003333771',
      devicePhase: 'A',
      requestType: 'TOP_UP_KWH',
      token: 'AABBCCDD',
    });
    expect(bytes).not.toBeNull();
    expect(bytes![8]).toBe(0x00); // token control code
  });

  it('returns fixed DLMS bytes for READ_POWER_LIMIT', () => {
    const bytes = encodeRequestData({
      deviceIdentifier: '47003333771',
      devicePhase: 'A',
      requestType: 'READ_POWER_LIMIT',
    });
    expect(bytes?.[0]).toBe(0x00);
    expect(bytes).toHaveLength(21);
  });

  it('returns null for unsupported command types', () => {
    expect(encodeRequestData({
      deviceIdentifier: '47003333771',
      devicePhase: 'A',
      requestType: 'READ_VERSION',
    })).toBeNull();
  });

  it('encodes SET_DATE BCD bytes (weekday/day/month/year after password)', () => {
    // 2026-03-15 UTC → Sunday (weekday 0)
    const bytes = encodeRequestData({
      deviceIdentifier: '47003333771',
      devicePhase: 'A',
      requestType: 'SET_DATE',
      payload: { year: 2026, month: 3, day: 15 },
    });
    expect(bytes).not.toBeNull();
    expect(bytes![8]).toBe(0x04); // writing control code

    // writeBytes = 4 password bytes (+0x33) + reversed date (+0x33)
    // Natural BCD: year 0x26, month 0x03, day 0x15, weekday 0x00
    // After +0x33 + reverse: [0x33, 0x48, 0x36, 0x59]
    const dateStart = bytes!.length - 2 - 4; // before checksum + end
    expect(bytes!.slice(dateStart, dateStart + 4)).toEqual([
      0x33, 0x48, 0x36, 0x59,
    ]);
  });

  it('returns null for SET_TIME when a field is outside BCD range', () => {
    // hour 25 is still valid BCD (0–99); use >99 to hit toBcd → null
    expect(encodeRequestData({
      deviceIdentifier: '47003333771',
      devicePhase: 'A',
      requestType: 'SET_TIME',
      payload: { hour: 100, minute: 0, second: 0 },
    })).toBeNull();
  });
});

describe('decodeResponseData', () => {
  it('decodes SEND_TOKEN_FAILURE with camelCase data', () => {
    // Legacy fixture: used-token failure frame
    const decoded = decodeResponseData('aCM2MwNwBGjAATTIFg==');
    expect(decoded).toEqual({
      status: 'EXECUTION_FAILURE',
      data: { tokenAccepted: false },
      failureContext: {
        reason: 'Delivery was successful but the token was not accepted',
      },
    });
  });

  it('returns null for invalid frame headers', () => {
    // Leading 0x00 takes the DLMS path — use a non-0x00 invalid frame instead.
    const invalid = Buffer.from([ 0x11, 0x22, 0x33, 0x16 ]).toString('base64');
    expect(decodeResponseData(invalid)).toBeNull();
  });
});

describe('eventCorrelator', () => {
  const device = {
    type: 'ELECTRICITY_METER' as const,
    externalReference: 'm-1',
  };

  const decoded = {
    status: 'EXECUTION_SUCCESS' as const,
    data: { kwhCreditAvailable: 1.5 },
  };

  it('combines when ACK arrives before UP', () => {
    expect(eventCorrelator.onAckEvent({
      queueItemId: 'q-1',
      deduplicationId: 'd-1',
      deviceInfo: { devEui: '0000047003333771' },
      acknowledged: true,
    })).toBeNull();
    expect(eventCorrelator.getPendingCount()).toBe(1);

    const combined = eventCorrelator.onUpEvent(
      {
        deduplicationId: 'd-1',
        deviceInfo: { devEui: '0000047003333771' },
        devAddr: 'addr',
        rxInfo: [],
        data: 'unused',
      },
      decoded,
      device,
    );

    expect(combined).toMatchObject({
      deliveryQueueId: 'q-1',
      deliveryStatus: 'DELIVERY_SUCCESSFUL',
      response: { status: 'EXECUTION_SUCCESS', data: { kwhCreditAvailable: 1.5 } },
      device,
    });
    expect(eventCorrelator.getPendingCount()).toBe(0);
  });

  it('combines when UP arrives before ACK', () => {
    expect(eventCorrelator.onUpEvent(
      {
        deduplicationId: 'd-2',
        deviceInfo: { devEui: '0000047003333771' },
        devAddr: 'addr',
        rxInfo: [],
        data: 'unused',
      },
      decoded,
      device,
    )).toBeNull();

    const combined = eventCorrelator.onAckEvent({
      queueItemId: 'q-2',
      deduplicationId: 'd-2',
      deviceInfo: { devEui: '0000047003333771' },
      acknowledged: true,
    });

    expect(combined).toMatchObject({
      deliveryQueueId: 'q-2',
      deliveryStatus: 'DELIVERY_SUCCESSFUL',
      device,
    });
    expect(eventCorrelator.getPendingCount()).toBe(0);
  });

  it('GC removes stale pending entries', () => {
    vi.useFakeTimers();
    eventCorrelator.onAckEvent({
      queueItemId: 'q-stale',
      deduplicationId: 'd-stale',
      deviceInfo: { devEui: '0000047003333771' },
      acknowledged: true,
    });
    expect(eventCorrelator.getPendingCount()).toBe(1);

    vi.advanceTimersByTime(10_001);
    eventCorrelator.runGarbageCollection();
    expect(eventCorrelator.getPendingCount()).toBe(0);
  });
});

describe('selectGatewayWithBestSignal', () => {
  it('prefers higher SNR, then higher RSSI', () => {
    const best = selectGatewayWithBestSignal([
      { gatewayId: 'gw-weak', snr: 1, rssi: -120 },
      { gatewayId: 'gw-best', snr: 10, rssi: -90 },
      { gatewayId: 'gw-mid', snr: 10, rssi: -100 },
    ]);
    expect(best).toEqual({
      externalReference: 'gw-best',
      snr: 10,
      rssi: -90,
    });
  });
});
