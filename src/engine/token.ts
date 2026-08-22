/**
 * @fileoverview Sync token generation surface.
 *
 * Thin router: `pluginId` → optional `plugin.token.generate`.
 */

import type { GenerateTokenRequest } from '../lib/device-message/types.js';
import type { PluginRegistry } from '../plugins/registry.js';
import { TokenNotSupportedError, UnknownPluginError } from './errors.js';

/**
 * Token operations used by HTTP.
 * Wired at the composition root (`main.ts`); unit tests inject a fake.
 */
export type TokenService = {
  /**
   * Mint one token via the named plugin.
   * @throws {@link UnknownPluginError} when the plugin is not enabled
   * @throws {@link TokenNotSupportedError} when the plugin has no `token` facet
   */
  generate(request: GenerateTokenRequest): Promise<string>;
};

/** Dependencies for {@link createTokenService}. */
export type CreateTokenServiceOptions = {
  readonly registry: PluginRegistry;
};

/**
 * Factory for sync token generation via plugin `token.generate`.
 *
 * @param options - Registry for enablement + capability lookup
 */
export function createTokenService(options: CreateTokenServiceOptions): TokenService {
  const { registry } = options;

  async function generate(request: GenerateTokenRequest): Promise<string> {
    const plugin = registry.get(request.pluginId);
    if (!plugin) {
      throw new UnknownPluginError(request.pluginId);
    }
    if (!plugin.token) {
      throw new TokenNotSupportedError(request.pluginId);
    }

    const { pluginId: _pluginId, ...input } = request;
    return plugin.token.generate(input);
  }

  return { generate };
}
