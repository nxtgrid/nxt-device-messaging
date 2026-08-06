import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CALIN_API_V2_ID,
  createCalinApiV2Plugin,
} from '#src/plugins/calin-api-v2/index.js';
import {
  CALIN_API_V2_ENV_KEYS,
  loadCalinApiV2Secrets,
} from '#src/plugins/calin-api-v2/lib/secrets.js';
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

/** Stub every required `CALIN_API_V2_*` key (cleared in {@link afterEach}). */
function stubValidCalinApiV2Env(): void {
  for (const key of CALIN_API_V2_ENV_KEYS) {
    vi.stubEnv(key, `test-${ key }`);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadCalinApiV2Secrets', () => {
  it('returns validated secrets when all keys are present', () => {
    stubValidCalinApiV2Env();
    expect(loadCalinApiV2Secrets()).toEqual({
      apiBaseUrl: 'test-CALIN_API_V2_URL',
      companyName: 'test-CALIN_API_V2_COMPANY_NAME',
      customerId: 'test-CALIN_API_V2_CUSTOMER_ID',
      adminUsername: 'test-CALIN_API_V2_ADMIN_USERNAME',
      adminPassword: 'test-CALIN_API_V2_ADMIN_PASSWORD',
      posPassword: 'test-CALIN_API_V2_POS_PASSWORD',
    });
  });

  it('throws MISSING naming the plugin and blank keys', () => {
    for (const key of CALIN_API_V2_ENV_KEYS) {
      vi.stubEnv(key, '');
    }
    expect(() => loadCalinApiV2Secrets()).toThrow(
      /MISSING env for plugin "calin-api-v2": CALIN_API_V2_URL/,
    );

    stubValidCalinApiV2Env();
    vi.stubEnv('CALIN_API_V2_ADMIN_PASSWORD', '   ');
    expect(() => loadCalinApiV2Secrets()).toThrow(/CALIN_API_V2_ADMIN_PASSWORD/);
  });

  it('trims surrounding whitespace on stored values', () => {
    stubValidCalinApiV2Env();
    vi.stubEnv('CALIN_API_V2_URL', '  https://calin-v2.example/api  ');
    vi.stubEnv('CALIN_API_V2_COMPANY_NAME', '  Acme  ');
    expect(loadCalinApiV2Secrets()).toMatchObject({
      apiBaseUrl: 'https://calin-v2.example/api',
      companyName: 'Acme',
    });
  });
});

describe('createCalinApiV2Plugin', () => {
  it('builds PULL + concurrency + queue:calin-api-v2:dcu:…', () => {
    stubValidCalinApiV2Env();
    const plugin = createCalinApiV2Plugin({ id: CALIN_API_V2_ID });
    expect(plugin.id).toBe(CALIN_API_V2_ID);
    expect(plugin.deliveryPattern).toBe('PULL');
    expect(plugin.supportedCommandTypes).toContain('READ_CREDIT');
    expect(plugin.supportedCommandTypes).toContain('DELIVER_PREEXISTING_TOKEN');
    expect(plugin.supportedCommandTypes).not.toContain('READ_TIME');
    expect(plugin.supportedCommandTypes).not.toContain('SET_TIME');
    expect(plugin.tuning).toEqual(EXPECTED_DEFAULT_TUNING);
    expect(plugin.admission).toEqual({ strategy: 'concurrency', maxInFlight: 5 });
    expect(
      plugin.initialQueueKey({
        networkId: null,
        device: { ...deviceOnly.device, relayNode: { id: 7 } },
      }),
    ).toBe('queue:calin-api-v2:dcu:7');
    // Still builds unassigned for cancel/requeue of legacy rows; enqueue rejects.
    expect(plugin.initialQueueKey(deviceOnly)).toBe(
      'queue:calin-api-v2:dcu:unassigned',
    );
    expect(plugin.incoming.fetchStatus).toBeTypeOf('function');
    expect(plugin.incoming.handle).toBeUndefined();
    expect(plugin.outgoing.getRemoteStatus).toBeUndefined();
    expect(plugin.token?.generate).toBeTypeOf('function');
  });

  it('validateEnqueue requires device.relayNode.id', () => {
    stubValidCalinApiV2Env();
    const plugin = createCalinApiV2Plugin({ id: CALIN_API_V2_ID });
    const base = {
      commandType: 'READ_CREDIT' as const,
      priority: 1,
      pluginId: CALIN_API_V2_ID,
      networkId: null,
      device: deviceOnly.device,
    };
    expect(plugin.validateEnqueue?.(base)).toBe('device.relayNode.id is required');
    expect(plugin.validateEnqueue?.({
      ...base,
      device: { ...deviceOnly.device, relayNode: { id: 7 } },
    })).toBeUndefined();
  });

  it('fails construct when secrets are missing', () => {
    for (const key of CALIN_API_V2_ENV_KEYS) {
      vi.stubEnv(key, '');
    }
    expect(() => createCalinApiV2Plugin({ id: CALIN_API_V2_ID })).toThrow(
      /MISSING env for plugin "calin-api-v2"/,
    );
  });

  it('merges config tuning over defaults', () => {
    stubValidCalinApiV2Env();
    const plugin = createCalinApiV2Plugin({
      id: CALIN_API_V2_ID,
      tuning: { initialPollDelayMs: 30_000 },
    });
    expect(plugin.tuning).toEqual({
      ...EXPECTED_DEFAULT_TUNING,
      initialPollDelayMs: 30_000,
    });
  });

  it('rejects unknown or invalid tuning keys', () => {
    stubValidCalinApiV2Env();
    expect(() => createCalinApiV2Plugin({
      id: CALIN_API_V2_ID,
      tuning: { notAKnob: 1 },
    })).toThrow(/Invalid tuning/);

    expect(() => createCalinApiV2Plugin({
      id: CALIN_API_V2_ID,
      tuning: { nsInFlightTimeoutMs: -1 },
    })).toThrow(/Invalid tuning/);
  });

  it('wires outgoing and incoming; token stays stub until 9.5', () => {
    stubValidCalinApiV2Env();
    const plugin = createCalinApiV2Plugin({ id: CALIN_API_V2_ID });
    expect(plugin.outgoing.sendOne).toBeTypeOf('function');
    expect(plugin.incoming.fetchStatus).toBeTypeOf('function');
    expect(plugin.token?.generate).toBeTypeOf('function');
  });

  it('registers via PLUGIN_CATALOG when env is present', () => {
    stubValidCalinApiV2Env();
    const registry = createPluginRegistry([ { id: CALIN_API_V2_ID } ]);
    expect(registry.get(CALIN_API_V2_ID)?.deliveryPattern).toBe('PULL');
  });
});
