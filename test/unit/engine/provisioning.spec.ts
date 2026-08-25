import { describe, expect, it, vi } from 'vitest';

import { createProvisioningService } from '#src/engine/provisioning.js';
import type { PluginRegistry } from '#src/plugins/registry.js';
import { createPluginRegistry } from '#src/plugins/registry.js';
import {
  createStubPushPlugin,
  STUB_PULL_ID,
  STUB_PUSH_ID,
} from '#src/plugins/stub/index.js';

const request = {
  pluginId: STUB_PUSH_ID,
  operation: 'registerDevice',
  payload: { devEui: '1', deviceName: 'm-1' },
};

describe('createProvisioningService', () => {
  it('delegates to plugin.provisioning.execute without pluginId', async () => {
    const execute = vi.fn(async () => ({ isNewRegistration: true }));
    const base = createStubPushPlugin({ id: STUB_PUSH_ID });
    const plugin = { ...base, provisioning: { execute } };
    const registry: PluginRegistry = {
      get: id => (id === STUB_PUSH_ID ? plugin : undefined),
      getAll: () => [ plugin ],
      getByDeliveryPattern: () => [],
    };
    const provisioningService = createProvisioningService({ registry });

    await expect(provisioningService.execute(request)).resolves.toEqual({
      isNewRegistration: true,
    });
    expect(execute).toHaveBeenCalledWith({
      operation: request.operation,
      payload: request.payload,
    });
  });

  it('throws UnknownPluginError for disabled plugin', async () => {
    const registry = createPluginRegistry([]);
    const provisioningService = createProvisioningService({ registry });

    await expect(provisioningService.execute(request)).rejects.toMatchObject({
      name: 'UnknownPluginError',
      pluginId: STUB_PUSH_ID,
    });
  });

  it('throws ProvisioningNotSupportedError when plugin has no facet', async () => {
    const registry = createPluginRegistry([ { id: STUB_PULL_ID } ]);
    const provisioningService = createProvisioningService({ registry });

    await expect(
      provisioningService.execute({ ...request, pluginId: STUB_PULL_ID }),
    ).rejects.toMatchObject({
      name: 'ProvisioningNotSupportedError',
      pluginId: STUB_PULL_ID,
    });
  });
});
