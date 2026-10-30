import { describe, expect, it } from 'vitest';

import { DEFAULT_PLUGIN_TUNING } from '#src/plugins/_shared/merge-plugin-tuning.js';
import { PLUGIN_CATALOG } from '#src/plugins/catalog.js';
import type { InitialQueueKeyInput } from '#src/plugins/plugin.interface.js';
import {
  SPARKMETER_SPARKNET_HTTP_ID,
  createSparkmeterSparknetHttpPlugin,
} from '#src/plugins/sparkmeter-sparknet-http/index.js';
import { loadSparkmeterSparknetHttpSettings } from '#src/plugins/sparkmeter-sparknet-http/settings.js';
import type { CreateDeviceMessage } from '#src/lib/device-message/types.js';

const METER_CONFIGURATION = {
  startupDelay: 0,
  throttleOnTime: 5,
  throttleOffTime: 10,
  throttleCountLimit: 5,
};

const BASESTATION = {
  id: 1,
  baseUrl: 'http://127.0.0.1:18080',
};

function settings(options?: {
  readonly currentLimit?: number;
  readonly basestations?: readonly { id: number; baseUrl: string }[];
  readonly meterConfiguration?: Record<string, number>;
}): Record<string, unknown> {
  return {
    basestations: options?.basestations ?? [ BASESTATION ],
    meterConfiguration: {
      ...METER_CONFIGURATION,
      ...options?.meterConfiguration,
      ...(options?.currentLimit === undefined ? {} : { currentLimit: options.currentLimit }),
    },
  };
}

function createPlugin(pluginSettings: Record<string, unknown> = settings()) {
  return createSparkmeterSparknetHttpPlugin({
    id: SPARKMETER_SPARKNET_HTTP_ID,
    settings: pluginSettings,
  });
}

function enqueue(
  commandType: CreateDeviceMessage['commandType'],
  requestData?: CreateDeviceMessage['requestData'],
  device?: Partial<CreateDeviceMessage['device']>,
): CreateDeviceMessage {
  return {
    commandType,
    priority: 10,
    pluginId: SPARKMETER_SPARKNET_HTTP_ID,
    networkId: null,
    device: {
      type: 'ELECTRICITY_METER',
      externalReference: '1001',
      relayNode: { id: 1 },
      ...device,
    },
    requestData,
  };
}

const deviceOnly: InitialQueueKeyInput = {
  networkId: null,
  device: {
    type: 'ELECTRICITY_METER',
    externalReference: '1001',
  },
};

describe('loadSparkmeterSparknetHttpSettings', () => {
  it('fills currentLimit with 200 A when the key is omitted', () => {
    const loaded = loadSparkmeterSparknetHttpSettings({
      id: SPARKMETER_SPARKNET_HTTP_ID,
      settings: settings(),
    });
    expect(loaded.meterConfiguration).toEqual({
      currentLimit: 200,
      ...METER_CONFIGURATION,
    });
  });

  it('keeps a present currentLimit, including zero', () => {
    const loaded = loadSparkmeterSparknetHttpSettings({
      id: SPARKMETER_SPARKNET_HTTP_ID,
      settings: settings({ currentLimit: 0 }),
    });
    expect(loaded.meterConfiguration.currentLimit).toBe(0);
  });

  it('accepts a zero on each required uint32', () => {
    const loaded = loadSparkmeterSparknetHttpSettings({
      id: SPARKMETER_SPARKNET_HTTP_ID,
      settings: settings({
        meterConfiguration: {
          startupDelay: 0,
          throttleOnTime: 0,
          throttleOffTime: 0,
          throttleCountLimit: 0,
        },
      }),
    });
    expect(loaded.meterConfiguration.startupDelay).toBe(0);
    expect(loaded.meterConfiguration.throttleCountLimit).toBe(0);
  });

  it('fails boot when settings or a required field are missing', () => {
    expect(() => loadSparkmeterSparknetHttpSettings({
      id: SPARKMETER_SPARKNET_HTTP_ID,
    })).toThrow(/settings are required/);

    const { startupDelay: _omitted, ...withoutStartupDelay } = METER_CONFIGURATION;
    expect(() => loadSparkmeterSparknetHttpSettings({
      id: SPARKMETER_SPARKNET_HTTP_ID,
      settings: {
        basestations: [ BASESTATION ],
        meterConfiguration: withoutStartupDelay,
      },
    })).toThrow(/startupDelay/);
  });

  it('fails boot on an empty basestation list, a duplicate id, or a bad value', () => {
    expect(() => loadSparkmeterSparknetHttpSettings({
      id: SPARKMETER_SPARKNET_HTTP_ID,
      settings: settings({ basestations: [] }),
    })).toThrow(/basestations/);

    expect(() => loadSparkmeterSparknetHttpSettings({
      id: SPARKMETER_SPARKNET_HTTP_ID,
      settings: settings({
        basestations: [ BASESTATION, { ...BASESTATION, baseUrl: 'http://10.0.0.2:18080' } ],
      }),
    })).toThrow(/duplicate basestation id 1/);

    expect(() => loadSparkmeterSparknetHttpSettings({
      id: SPARKMETER_SPARKNET_HTTP_ID,
      settings: settings({ currentLimit: -1 }),
    })).toThrow(/currentLimit/);

    expect(() => loadSparkmeterSparknetHttpSettings({
      id: SPARKMETER_SPARKNET_HTTP_ID,
      settings: { ...settings(), power_limit: 1 },
    })).toThrow(/Invalid settings/);
  });
});

describe('createSparkmeterSparknetHttpPlugin', () => {
  it('is a PUSH plugin with one basestation queue and concurrency 1', () => {
    const plugin = createPlugin();
    expect(plugin.id).toBe(SPARKMETER_SPARKNET_HTTP_ID);
    expect(plugin.deliveryPattern).toBe('PUSH');
    expect(plugin.supportedCommandTypes).toEqual([
      'TURN_ON',
      'TURN_OFF',
      'SET_POWER_LIMIT',
    ]);
    expect(plugin.relayNodeNoun).toBe('basestation');
    expect(plugin.admission).toEqual({ strategy: 'concurrency', maxInFlight: 1 });
    expect(plugin.tuning).toEqual({
      ...DEFAULT_PLUGIN_TUNING,
      nsInFlightTimeoutMs: 10_000,
      relayNodeInFlightTimeoutMs: 30_000,
      deviceInFlightTimeoutMs: 60_000,
    });
    expect(plugin.initialQueueKey({
      networkId: null,
      device: { ...deviceOnly.device, relayNode: { id: 1 } },
    })).toBe('queue:sparkmeter-sparknet-http:basestation:1');
    expect(plugin.initialQueueKey(deviceOnly)).toBe(
      'queue:sparkmeter-sparknet-http:basestation:unassigned',
    );
    expect(plugin.outgoing.getRemoteStatus).toBeUndefined();
    expect(plugin.incoming.handle({})).toBeNull();
    expect(plugin.token).toBeUndefined();
    expect(plugin.provisioning).toBeUndefined();
  });

  it('lets plugins[].tuning override a development deadline', () => {
    const plugin = createSparkmeterSparknetHttpPlugin({
      id: SPARKMETER_SPARKNET_HTTP_ID,
      settings: settings(),
      tuning: { deviceInFlightTimeoutMs: 120_000 },
    });
    expect(plugin.tuning.deviceInFlightTimeoutMs).toBe(120_000);
    expect(plugin.tuning.nsInFlightTimeoutMs).toBe(10_000);
  });

  it('rejects unknown tuning keys', () => {
    expect(() => createSparkmeterSparknetHttpPlugin({
      id: SPARKMETER_SPARKNET_HTTP_ID,
      settings: settings(),
      tuning: { notAKnob: 1 },
    })).toThrow(/Invalid tuning/);
  });

  it('registers via PLUGIN_CATALOG', () => {
    const plugin = PLUGIN_CATALOG[SPARKMETER_SPARKNET_HTTP_ID]({
      id: SPARKMETER_SPARKNET_HTTP_ID,
      settings: settings(),
    });
    expect(plugin.deliveryPattern).toBe('PUSH');
  });
});

describe('validateEnqueue', () => {
  const plugin = createPlugin(settings({
    basestations: [
      BASESTATION,
      { id: 0, baseUrl: 'http://127.0.0.1:18081' },
    ],
  }));

  it('requires a configured basestation id', () => {
    expect(plugin.validateEnqueue?.(enqueue('TURN_ON', {
      deviceState: { powerLimit: 0 },
    }, { relayNode: undefined }))).toBe('device.relayNode.id is required');

    expect(plugin.validateEnqueue?.(enqueue('TURN_ON', {
      deviceState: { powerLimit: 0 },
    }, { relayNode: { id: 9 } }))).toBe(
      'device.relayNode.id is not a configured basestation',
    );
  });

  it('requires externalReference to be a canonical base-10 uint64', () => {
    const accept = [ '0', '1001', '18446744073709551615' ];
    const reject = [ '00', '01', '+1', '-1', '1.5', '0x10', ' 1', '18446744073709551616' ];

    for (const externalReference of accept) {
      expect(plugin.validateEnqueue?.(enqueue('TURN_ON', {
        deviceState: { powerLimit: 0 },
      }, { externalReference })), externalReference).toBeUndefined();
    }
    for (const externalReference of reject) {
      expect(plugin.validateEnqueue?.(enqueue('TURN_ON', {
        deviceState: { powerLimit: 0 },
      }, { externalReference })), externalReference).toBe(
        'device.externalReference must be a base-10 uint64',
      );
    }
  });

  it('accepts basestation id 0', () => {
    expect(plugin.validateEnqueue?.(enqueue('TURN_ON', {
      deviceState: { powerLimit: 1000 },
    }, { relayNode: { id: 0 } }))).toBeUndefined();
  });

  it('requires powerLimit and rejects relay and payload on TURN_ON and TURN_OFF', () => {
    for (const commandType of [ 'TURN_ON', 'TURN_OFF' ] as const) {
      expect(plugin.validateEnqueue?.(enqueue(commandType, {
        deviceState: { powerLimit: 0 },
      }))).toBeUndefined();

      expect(plugin.validateEnqueue?.(enqueue(commandType, {
        payload: { powerLimit: 1 },
        deviceState: { powerLimit: 1 },
      }))).toBe(`${ commandType } rejects requestData.payload`);

      expect(plugin.validateEnqueue?.(enqueue(commandType, {
        deviceState: { powerLimit: 1, relay: 'ON' },
      }))).toBe(`${ commandType } rejects deviceState.relay`);

      expect(plugin.validateEnqueue?.(enqueue(commandType, {
        deviceState: { relay: 'OFF' },
      }))).toBe(`${ commandType } rejects deviceState.relay`);

      expect(plugin.validateEnqueue?.(enqueue(commandType))).toBe(
        `${ commandType } requires deviceState.powerLimit`,
      );
    }
  });

  it('requires payload powerLimit and deviceState.relay on SET_POWER_LIMIT', () => {
    expect(plugin.validateEnqueue?.(enqueue('SET_POWER_LIMIT', {
      payload: { powerLimit: 0 },
      deviceState: { relay: 'OFF' },
    }))).toBeUndefined();

    expect(plugin.validateEnqueue?.(enqueue('SET_POWER_LIMIT', {
      payload: { powerLimit: 1200 },
      deviceState: { relay: 'ON', powerLimit: 0 },
    }))).toBe('SET_POWER_LIMIT rejects deviceState.powerLimit');

    expect(plugin.validateEnqueue?.(enqueue('SET_POWER_LIMIT', {
      deviceState: { relay: 'ON' },
    }))).toBe('SET_POWER_LIMIT requires requestData.payload { powerLimit }');

    expect(plugin.validateEnqueue?.(enqueue('SET_POWER_LIMIT', {
      payload: { year: 2026, month: 8, day: 12 },
      deviceState: { relay: 'ON' },
    }))).toBe('SET_POWER_LIMIT requires requestData.payload { powerLimit }');

    expect(plugin.validateEnqueue?.(enqueue('SET_POWER_LIMIT', {
      payload: { powerLimit: 1200 },
    }))).toBe('SET_POWER_LIMIT requires deviceState.relay');
  });
});
