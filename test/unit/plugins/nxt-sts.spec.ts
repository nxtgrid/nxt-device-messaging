import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DeviceMessage } from '#src/lib/device-message/types.js';
import {
  createNxtStsPlugin,
  NXT_STS_ID,
} from '#src/plugins/nxt-sts/index.js';
import {
  loadNxtStsSecrets,
  NXT_STS_ENV_KEYS,
} from '#src/plugins/nxt-sts/lib/secrets.js';
import type { InitialQueueKeyInput } from '#src/plugins/plugin.interface.js';
import { createPluginRegistry } from '#src/plugins/registry.js';

/** Expected code defaults (asserted via factory; not imported from the plugin). */
const EXPECTED_DEFAULT_TUNING = {
  nsInFlightTimeoutMs: 20_000,
  relayNodeInFlightTimeoutMs: 900_000,
  deviceInFlightTimeoutMs: 12_000,
  initialPollDelayMs: 10_000,
} as const;

const deviceOnly: InitialQueueKeyInput = {
  networkId: 42,
  device: {
    type: 'ELECTRICITY_METER',
    externalReference: 'm-1',
  },
};

/** Stub every required `NXT_STS_*` key (cleared in {@link afterEach}). */
function stubValidNxtStsEnv(): void {
  for (const key of NXT_STS_ENV_KEYS) {
    vi.stubEnv(key, `test-${ key }`);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadNxtStsSecrets', () => {
  it('returns validated secrets when all keys are present', () => {
    stubValidNxtStsEnv();
    expect(loadNxtStsSecrets()).toEqual({
      apiBaseUrl: 'test-NXT_STS_URL',
    });
  });

  it('throws MISSING naming the plugin and blank keys', () => {
    vi.stubEnv('NXT_STS_URL', '');
    expect(() => loadNxtStsSecrets()).toThrow(
      /MISSING env for plugin "nxt-sts": NXT_STS_URL/,
    );

    stubValidNxtStsEnv();
    vi.stubEnv('NXT_STS_URL', '   ');
    expect(() => loadNxtStsSecrets()).toThrow(/NXT_STS_URL/);
  });

  it('trims surrounding whitespace on stored values', () => {
    stubValidNxtStsEnv();
    vi.stubEnv('NXT_STS_URL', '  http://sts.example  ');
    expect(loadNxtStsSecrets()).toEqual({
      apiBaseUrl: 'http://sts.example',
    });
  });
});

describe('createNxtStsPlugin', () => {
  it('builds token-only PULL + empty command types + queue:nxt-sts:none:na', () => {
    stubValidNxtStsEnv();
    const plugin = createNxtStsPlugin({ id: NXT_STS_ID });
    expect(plugin.id).toBe(NXT_STS_ID);
    expect(plugin.deliveryPattern).toBe('PULL');
    expect(plugin.supportedCommandTypes).toEqual([]);
    expect(plugin.tuning).toEqual(EXPECTED_DEFAULT_TUNING);
    expect(plugin.admission).toEqual({ strategy: 'concurrency', maxInFlight: 1 });
    expect(plugin.initialQueueKey(deviceOnly)).toBe('queue:nxt-sts:none:na');
    expect(plugin.incoming.handle).toBeUndefined();
    expect(plugin.incoming.fetchStatus).toBeUndefined();
    expect(plugin.outgoing.getRemoteStatus).toBeUndefined();
    expect(plugin.token?.generate).toBeTypeOf('function');
  });

  it('outgoing.sendOne rejects (token-only)', async () => {
    stubValidNxtStsEnv();
    const plugin = createNxtStsPlugin({ id: NXT_STS_ID });
    const message = {
      id: 'msg-1',
      commandType: 'TOP_UP_KWH',
      pluginId: NXT_STS_ID,
      networkId: null,
      device: deviceOnly.device,
      deliveryQueueId: '',
      deliveryStatus: 'QUEUED',
    } as DeviceMessage;
    await expect(plugin.outgoing.sendOne(message)).rejects.toThrow(/token-only/);
  });

  it('fails construct when secrets are missing', () => {
    vi.stubEnv('NXT_STS_URL', '');
    expect(() => createNxtStsPlugin({ id: NXT_STS_ID })).toThrow(
      /MISSING env for plugin "nxt-sts"/,
    );
  });

  it('merges config tuning over defaults', () => {
    stubValidNxtStsEnv();
    const plugin = createNxtStsPlugin({
      id: NXT_STS_ID,
      tuning: { initialPollDelayMs: 30_000 },
    });
    expect(plugin.tuning).toEqual({
      ...EXPECTED_DEFAULT_TUNING,
      initialPollDelayMs: 30_000,
    });
  });

  it('rejects unknown or invalid tuning keys', () => {
    stubValidNxtStsEnv();
    expect(() => createNxtStsPlugin({
      id: NXT_STS_ID,
      tuning: { notAKnob: 1 },
    })).toThrow(/Invalid tuning/);

    expect(() => createNxtStsPlugin({
      id: NXT_STS_ID,
      tuning: { nsInFlightTimeoutMs: -1 },
    })).toThrow(/Invalid tuning/);
  });

  it('registers via PLUGIN_CATALOG when env is present', () => {
    stubValidNxtStsEnv();
    const registry = createPluginRegistry([ { id: NXT_STS_ID } ]);
    expect(registry.get(NXT_STS_ID)?.token?.generate).toBeTypeOf('function');
  });
});
