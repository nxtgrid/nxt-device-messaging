import { describe, expect, it } from 'vitest';

import { createTokenService } from '../../../src/engine/token.js';
import { createPluginRegistry } from '../../../src/plugins/registry.js';
import {
  STUB_PULL_ID,
  STUB_PUSH_ID,
  STUB_TOKEN_VALUE,
} from '../../../src/plugins/stub/index.js';

const request = {
  pluginId: STUB_PUSH_ID,
  type: 'TOP_UP_KWH' as const,
  issueDateString: '2026-08-03',
  device: { externalReference: 'm-1' },
};

describe('createTokenService', () => {
  it('delegates to stub-push token.generate', async () => {
    const registry = createPluginRegistry([ { id: STUB_PUSH_ID } ]);
    const tokenService = createTokenService({ registry });

    await expect(tokenService.generate(request)).resolves.toBe(STUB_TOKEN_VALUE);
  });

  it('throws UnknownPluginError for disabled plugin', async () => {
    const registry = createPluginRegistry([]);
    const tokenService = createTokenService({ registry });

    await expect(tokenService.generate(request)).rejects.toMatchObject({
      name: 'UnknownPluginError',
      pluginId: STUB_PUSH_ID,
    });
  });

  it('throws TokenNotSupportedError when plugin has no token facet', async () => {
    const registry = createPluginRegistry([ { id: STUB_PULL_ID } ]);
    const tokenService = createTokenService({ registry });

    await expect(
      tokenService.generate({ ...request, pluginId: STUB_PULL_ID }),
    ).rejects.toMatchObject({
      name: 'TokenNotSupportedError',
      pluginId: STUB_PULL_ID,
    });
  });
});
