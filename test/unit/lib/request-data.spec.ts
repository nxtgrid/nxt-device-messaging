import { describe, expect, it } from 'vitest';

import {
  createDeviceMessageSchema,
  deviceStateSchema,
  generateTokenSchema,
  powerLimitPayloadSchema,
} from '#src/lib/device-message/schemas.js';

const enqueueBase = {
  commandType: 'TURN_ON' as const,
  priority: 10,
  pluginId: 'sparkmeter-sparknet-http',
  networkId: null,
  device: {
    type: 'ELECTRICITY_METER' as const,
    externalReference: '1001',
  },
};

const tokenBase = {
  pluginId: 'nxt-sts',
  issueDateString: '2026-08-12',
  device: { externalReference: 'METER-1001' },
};

describe('powerLimitPayloadSchema', () => {
  it('accepts any JSON number, including zero', () => {
    expect(powerLimitPayloadSchema.parse({ powerLimit: 0 })).toEqual({ powerLimit: 0 });
    expect(powerLimitPayloadSchema.parse({ powerLimit: 1200 })).toEqual({ powerLimit: 1200 });
    expect(powerLimitPayloadSchema.parse({ powerLimit: 1.5 })).toEqual({ powerLimit: 1.5 });
    expect(powerLimitPayloadSchema.safeParse({ powerLimit: -1 }).success).toBe(true);
  });

  it('rejects a missing, non-numeric, or extra field', () => {
    expect(powerLimitPayloadSchema.safeParse({}).success).toBe(false);
    expect(powerLimitPayloadSchema.safeParse({ powerLimit: '1200' }).success).toBe(false);
    expect(powerLimitPayloadSchema.safeParse({
      powerLimit: 0,
      currentLimit: 200,
    }).success).toBe(false);
  });
});

describe('deviceStateSchema', () => {
  it('accepts powerLimit, relay, both, or neither', () => {
    expect(deviceStateSchema.parse({})).toEqual({});
    expect(deviceStateSchema.parse({ powerLimit: 0 })).toEqual({ powerLimit: 0 });
    expect(deviceStateSchema.parse({ relay: 'ON' })).toEqual({ relay: 'ON' });
    expect(deviceStateSchema.parse({ powerLimit: 1000, relay: 'OFF' })).toEqual({
      powerLimit: 1000,
      relay: 'OFF',
    });
  });

  it('rejects an unknown relay or an extra key', () => {
    expect(deviceStateSchema.safeParse({ relay: 'on' }).success).toBe(false);
    expect(deviceStateSchema.safeParse({
      powerLimit: 1,
      currentLimit: 200,
    }).success).toBe(false);
  });
});

describe('requestData on enqueue', () => {
  it('leaves token, payload, and deviceState optional', () => {
    expect(createDeviceMessageSchema.safeParse(enqueueBase).success).toBe(true);
    expect(createDeviceMessageSchema.safeParse({
      ...enqueueBase,
      commandType: 'SET_POWER_LIMIT',
      requestData: { token: '12345678901234567890' },
    }).success).toBe(true);
  });

  it('accepts a power-limit payload and deviceState without tying them to commandType', () => {
    expect(createDeviceMessageSchema.safeParse({
      ...enqueueBase,
      requestData: { deviceState: { powerLimit: 0 } },
    }).success).toBe(true);
    expect(createDeviceMessageSchema.safeParse({
      ...enqueueBase,
      commandType: 'SET_POWER_LIMIT',
      requestData: {
        payload: { powerLimit: 1200 },
        deviceState: { relay: 'ON' },
      },
    }).success).toBe(true);
    expect(createDeviceMessageSchema.safeParse({
      ...enqueueBase,
      requestData: {
        payload: { powerLimit: 1 },
        deviceState: { relay: 'OFF' },
      },
    }).success).toBe(true);
  });

  it('still accepts a date payload and rejects a mixed or oversized body', () => {
    expect(createDeviceMessageSchema.safeParse({
      ...enqueueBase,
      commandType: 'SET_DATE',
      requestData: { payload: { year: 2026, month: 8, day: 12 } },
    }).success).toBe(true);
    expect(createDeviceMessageSchema.safeParse({
      ...enqueueBase,
      requestData: { payload: { powerLimit: 1200, year: 2026 } },
    }).success).toBe(false);
    expect(createDeviceMessageSchema.safeParse({
      ...enqueueBase,
      requestData: {
        deviceState: { powerLimit: 1, relay: 'ON', currentLimit: 200 },
      },
    }).success).toBe(false);
  });
});

describe('generateTokenSchema SET_POWER_LIMIT', () => {
  it('uses the shared power-limit payload, including zero', () => {
    const parsed = generateTokenSchema.parse({
      ...tokenBase,
      type: 'SET_POWER_LIMIT',
      payload: { powerLimit: 0 },
    });

    expect(parsed).toMatchObject({ payload: { powerLimit: 0 } });
    expect(generateTokenSchema.safeParse({
      ...tokenBase,
      type: 'SET_POWER_LIMIT',
      payload: { powerLimit: 1200, extra: true },
    }).success).toBe(false);
  });
});
