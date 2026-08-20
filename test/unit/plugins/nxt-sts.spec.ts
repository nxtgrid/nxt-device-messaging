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
import { createPluginRegistry } from '#src/plugins/registry.js';

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
  it('builds token-only NONE with empty command types and no delivery fields', () => {
    stubValidNxtStsEnv();
    const plugin = createNxtStsPlugin({ id: NXT_STS_ID });
    expect(plugin.id).toBe(NXT_STS_ID);
    expect(plugin.deliveryPattern).toBe('NONE');
    expect(plugin.supportedCommandTypes).toEqual([]);
    expect(plugin.incoming).toBeUndefined();
    expect(plugin.admission).toBeUndefined();
    expect(plugin.tuning).toBeUndefined();
    expect(plugin.initialQueueKey).toBeUndefined();
    expect(plugin.outgoing.getRemoteStatus).toBeUndefined();
    expect(plugin.token.generate).toBeTypeOf('function');
  });

  it('outgoing.sendOne rejects (token-only)', async () => {
    stubValidNxtStsEnv();
    const plugin = createNxtStsPlugin({ id: NXT_STS_ID });
    const message = {
      id: 'msg-1',
      commandType: 'TOP_UP_KWH',
      pluginId: NXT_STS_ID,
      networkId: null,
      device: {
        type: 'ELECTRICITY_METER',
        externalReference: 'm-1',
      },
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

  it('registers via PLUGIN_CATALOG when env is present', () => {
    stubValidNxtStsEnv();
    const registry = createPluginRegistry([ { id: NXT_STS_ID } ]);
    expect(registry.get(NXT_STS_ID)?.token?.generate).toBeTypeOf('function');
    expect(registry.get(NXT_STS_ID)?.deliveryPattern).toBe('NONE');
  });
});
