import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CALIN_API_V1_ID,
  createCalinApiV1Plugin,
} from '#src/plugins/calin-api-v1/index.js';
import {
  CALIN_API_V1_ENV_KEYS,
  loadCalinApiV1Secrets,
} from '#src/plugins/calin-api-v1/lib/secrets.js';
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

/** Stub every required `CALIN_API_V1_*` key (cleared in {@link afterEach}). */
function stubValidCalinApiV1Env(): void {
  for (const key of CALIN_API_V1_ENV_KEYS) {
    vi.stubEnv(key, `test-${ key }`);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadCalinApiV1Secrets', () => {
  it('returns validated secrets when all keys are present', () => {
    stubValidCalinApiV1Env();
    expect(loadCalinApiV1Secrets()).toEqual({
      apiBaseUrl: 'test-CALIN_API_V1_URL',
      companyName: 'test-CALIN_API_V1_COMPANY_NAME',
      adminUsername: 'test-CALIN_API_V1_ADMIN_USERNAME',
      adminPassword: 'test-CALIN_API_V1_ADMIN_PASSWORD',
      posUsername: 'test-CALIN_API_V1_POS_USERNAME',
      posPassword: 'test-CALIN_API_V1_POS_PASSWORD',
      maintenanceUsername: 'test-CALIN_API_V1_MAINTENANCE_USERNAME',
      maintenancePassword: 'test-CALIN_API_V1_MAINTENANCE_PASSWORD',
    });
  });

  it('throws MISSING naming the plugin and blank keys', () => {
    for (const key of CALIN_API_V1_ENV_KEYS) {
      vi.stubEnv(key, '');
    }
    expect(() => loadCalinApiV1Secrets()).toThrow(
      /MISSING env for plugin "calin-api-v1": CALIN_API_V1_URL/,
    );

    stubValidCalinApiV1Env();
    vi.stubEnv('CALIN_API_V1_ADMIN_PASSWORD', '   ');
    expect(() => loadCalinApiV1Secrets()).toThrow(/CALIN_API_V1_ADMIN_PASSWORD/);
  });
});

describe('createCalinApiV1Plugin', () => {
  it('builds PULL + concurrency + queue:calin-api-v1:dcu:…', () => {
    stubValidCalinApiV1Env();
    const plugin = createCalinApiV1Plugin({ id: CALIN_API_V1_ID });
    expect(plugin.id).toBe(CALIN_API_V1_ID);
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
    ).toBe('queue:calin-api-v1:dcu:7');
    expect(plugin.initialQueueKey(deviceOnly)).toBe(
      'queue:calin-api-v1:dcu:unassigned',
    );
    expect(plugin.incoming.fetchStatus).toBeTypeOf('function');
    expect(plugin.incoming.handle).toBeUndefined();
    expect(plugin.outgoing.getRemoteStatus).toBeUndefined();
    expect(plugin.token?.generate).toBeTypeOf('function');
  });

  it('fails construct when secrets are missing', () => {
    for (const key of CALIN_API_V1_ENV_KEYS) {
      vi.stubEnv(key, '');
    }
    expect(() => createCalinApiV1Plugin({ id: CALIN_API_V1_ID })).toThrow(
      /MISSING env for plugin "calin-api-v1"/,
    );
  });

  it('merges config tuning over defaults', () => {
    stubValidCalinApiV1Env();
    const plugin = createCalinApiV1Plugin({
      id: CALIN_API_V1_ID,
      tuning: { initialPollDelayMs: 30_000 },
    });
    expect(plugin.tuning).toEqual({
      ...EXPECTED_DEFAULT_TUNING,
      initialPollDelayMs: 30_000,
    });
  });

  it('rejects unknown or invalid tuning keys', () => {
    stubValidCalinApiV1Env();
    expect(() => createCalinApiV1Plugin({
      id: CALIN_API_V1_ID,
      tuning: { notAKnob: 1 },
    })).toThrow(/Invalid tuning/);

    expect(() => createCalinApiV1Plugin({
      id: CALIN_API_V1_ID,
      tuning: { nsInFlightTimeoutMs: -1 },
    })).toThrow(/Invalid tuning/);
  });

  it('wires outgoing, incoming, and token facets', () => {
    stubValidCalinApiV1Env();
    const plugin = createCalinApiV1Plugin({ id: CALIN_API_V1_ID });
    expect(plugin.outgoing.sendOne).toBeTypeOf('function');
    expect(plugin.incoming.fetchStatus).toBeTypeOf('function');
    expect(plugin.token?.generate).toBeTypeOf('function');
  });

  it('registers via PLUGIN_CATALOG when env is present', () => {
    stubValidCalinApiV1Env();
    const registry = createPluginRegistry([ { id: CALIN_API_V1_ID } ]);
    expect(registry.get(CALIN_API_V1_ID)?.deliveryPattern).toBe('PULL');
  });
});
