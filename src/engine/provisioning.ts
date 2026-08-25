/**
 * @fileoverview Sync plugin provisioning surface.
 *
 * Thin router: `pluginId` → optional `plugin.provisioning.execute`.
 */

import type { PluginId } from '../lib/device-message/types.js';
import type { PluginRegistry } from '../plugins/registry.js';
import {
  ProvisioningNotSupportedError,
  UnknownPluginError,
} from './errors.js';

/** Wire / service request for {@link ProvisioningService.execute}. */
export type ProvisioningRequest = {
  readonly pluginId: PluginId;
  readonly operation: string;
  readonly payload: unknown;
};

/**
 * Provisioning operations used by HTTP.
 * Wired at the composition root (`main.ts`); unit tests inject a fake.
 */
export type ProvisioningService = {
  /**
   * Run one allowlisted vendor operation via the named plugin.
   * @throws {@link UnknownPluginError} when the plugin is not enabled
   * @throws {@link ProvisioningNotSupportedError} when the plugin has no facet
   * @throws InvalidProvisioningError when the plugin rejects the input
   */
  execute(request: ProvisioningRequest): Promise<unknown>;
};

/**
 * Factory for sync provisioning via plugin `provisioning.execute`.
 *
 * @param options - Registry for enablement + capability lookup
 */
export function createProvisioningService(options: {
  readonly registry: PluginRegistry;
}): ProvisioningService {
  const { registry } = options;

  async function execute(request: ProvisioningRequest): Promise<unknown> {
    const plugin = registry.get(request.pluginId);
    if (!plugin) {
      throw new UnknownPluginError(request.pluginId);
    }
    if (!plugin.provisioning) {
      throw new ProvisioningNotSupportedError(request.pluginId);
    }

    return plugin.provisioning.execute({
      operation: request.operation,
      payload: request.payload,
    });
  }

  return { execute };
}
