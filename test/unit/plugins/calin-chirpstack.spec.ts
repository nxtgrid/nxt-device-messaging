import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CALIN_CHIRPSTACK_ID,
  createCalinChirpstackPlugin,
} from '#src/plugins/calin-chirpstack/index.js';
import {
  CHIRPSTACK_ENV_KEYS,
  loadChirpstackSecrets,
} from '#src/plugins/_shared/chirpstack-repository/secrets.js';
import { DEFAULT_PLUGIN_TUNING } from '#src/plugins/_shared/merge-plugin-tuning.js';
import type { InitialQueueKeyInput } from '#src/plugins/plugin.interface.js';
import { createPluginRegistry } from '#src/plugins/registry.js';

const deviceOnly: InitialQueueKeyInput = {
  networkId: 42,
  device: {
    type: 'ELECTRICITY_METER',
    externalReference: 'm-1',
  },
};

/** Stub every required `CHIRPSTACK_*` key (cleared in {@link afterEach}). */
function stubValidChirpstackEnv(): void {
  for (const key of CHIRPSTACK_ENV_KEYS) {
    vi.stubEnv(key, `test-${ key }`);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadChirpstackSecrets', () => {
  it('returns validated secrets when all keys are present', () => {
    stubValidChirpstackEnv();
    expect(loadChirpstackSecrets()).toEqual({
      apiUrl: 'test-CHIRPSTACK_API_URL',
      apiToken: 'test-CHIRPSTACK_API_TOKEN',
      applicationId: 'test-CHIRPSTACK_APPLICATION_ID',
      profileId: 'test-CHIRPSTACK_PROFILE_ID',
      appKey: 'test-CHIRPSTACK_APP_KEY',
    });
  });

  it('throws MISSING naming chirpstack and blank keys', () => {
    for (const key of CHIRPSTACK_ENV_KEYS) {
      vi.stubEnv(key, '');
    }
    expect(() => loadChirpstackSecrets()).toThrow(
      /MISSING env for plugin "chirpstack": CHIRPSTACK_API_URL/,
    );

    stubValidChirpstackEnv();
    vi.stubEnv('CHIRPSTACK_API_TOKEN', '   ');
    expect(() => loadChirpstackSecrets()).toThrow(/CHIRPSTACK_API_TOKEN/);
  });

  it('trims surrounding whitespace on stored values', () => {
    stubValidChirpstackEnv();
    vi.stubEnv('CHIRPSTACK_API_URL', '  chirpstack.example:8080  ');
    vi.stubEnv('CHIRPSTACK_APPLICATION_ID', '  app-1  ');
    expect(loadChirpstackSecrets()).toMatchObject({
      apiUrl: 'chirpstack.example:8080',
      applicationId: 'app-1',
    });
  });
});

describe('createCalinChirpstackPlugin', () => {
  it('builds PUSH + spacing + queue:calin-chirpstack:network:…', () => {
    stubValidChirpstackEnv();
    const plugin = createCalinChirpstackPlugin({ id: CALIN_CHIRPSTACK_ID });
    expect(plugin.id).toBe(CALIN_CHIRPSTACK_ID);
    expect(plugin.deliveryPattern).toBe('PUSH');
    expect(plugin.supportedCommandTypes).toContain('READ_CREDIT');
    expect(plugin.supportedCommandTypes).toContain('READ_TIME');
    expect(plugin.supportedCommandTypes).toContain('SET_TIME');
    expect(plugin.supportedCommandTypes).toContain('DELIVER_PREEXISTING_TOKEN');
    expect(plugin.supportedCommandTypes).not.toContain('READ_VERSION');
    expect(plugin.tuning).toEqual(DEFAULT_PLUGIN_TUNING);
    expect(plugin.admission).toEqual({ strategy: 'spacing', minIntervalMs: 2_000 });
    expect(plugin.initialQueueKey(deviceOnly)).toBe(
      'queue:calin-chirpstack:network:42',
    );
    expect(
      plugin.initialQueueKey({ ...deviceOnly, networkId: null }),
    ).toBe('queue:calin-chirpstack:network:unassigned');
    expect(plugin.incoming.handle).toBeTypeOf('function');
    expect(plugin.incoming.fetchStatus).toBeUndefined();
    expect(plugin.outgoing.getRemoteStatus).toBeTypeOf('function');
    expect(plugin.token).toBeUndefined();
    expect(plugin.validateEnqueue).toBeUndefined();
  });

  it('fails construct when ChirpStack client secrets are missing', () => {
    for (const key of CHIRPSTACK_ENV_KEYS) {
      vi.stubEnv(key, '');
    }
    expect(() => createCalinChirpstackPlugin({ id: CALIN_CHIRPSTACK_ID })).toThrow(
      /MISSING env for plugin "chirpstack"/,
    );
  });

  it('merges config tuning over defaults', () => {
    stubValidChirpstackEnv();
    const plugin = createCalinChirpstackPlugin({
      id: CALIN_CHIRPSTACK_ID,
      tuning: { deviceInFlightTimeoutMs: 30_000 },
    });
    expect(plugin.tuning).toEqual({
      ...DEFAULT_PLUGIN_TUNING,
      deviceInFlightTimeoutMs: 30_000,
    });
  });

  it('rejects unknown or invalid tuning keys', () => {
    stubValidChirpstackEnv();
    expect(() => createCalinChirpstackPlugin({
      id: CALIN_CHIRPSTACK_ID,
      tuning: { notAKnob: 1 },
    })).toThrow(/Invalid tuning/);

    expect(() => createCalinChirpstackPlugin({
      id: CALIN_CHIRPSTACK_ID,
      tuning: { nsInFlightTimeoutMs: -1 },
    })).toThrow(/Invalid tuning/);
  });

  it('wires outgoing and incoming facets', () => {
    stubValidChirpstackEnv();
    const plugin = createCalinChirpstackPlugin({ id: CALIN_CHIRPSTACK_ID });
    expect(plugin.outgoing.sendOne).toBeTypeOf('function');
    expect(plugin.outgoing.getRemoteStatus).toBeTypeOf('function');
    expect(plugin.outgoing.parseError).toBeTypeOf('function');
    expect(plugin.incoming.handle).toBeTypeOf('function');
    expect(plugin.incoming.fetchStatus).toBeUndefined();
    expect(plugin.incoming.handle?.({})).toBeNull();
  });

  it('registers via PLUGIN_CATALOG when env is present', () => {
    stubValidChirpstackEnv();
    const registry = createPluginRegistry([ { id: CALIN_CHIRPSTACK_ID } ]);
    expect(registry.get(CALIN_CHIRPSTACK_ID)?.deliveryPattern).toBe('PUSH');
  });
});
