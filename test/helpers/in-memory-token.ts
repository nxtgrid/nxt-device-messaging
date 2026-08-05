/**
 * @fileoverview In-memory {@link TokenService} for HTTP unit tests (no Valkey).
 */

import { TokenNotSupportedError, UnknownPluginError } from '#src/engine/errors.js';
import type { TokenService } from '#src/engine/token.js';
import type { PluginId } from '#src/lib/device-message/types.js';

export type InMemoryTokenServiceOptions = {
  /** Plugin ids that accept generate (default: all). */
  readonly knownPluginIds?: readonly PluginId[];
  /** Plugin ids that are known but have no token facet. */
  readonly unsupportedPluginIds?: readonly PluginId[];
  /** Fixed token string returned on success (default `stub-token`). */
  readonly tokenValue?: string;
};

/** Process-local token surface for route / app unit tests. */
export function createInMemoryTokenService(
  options: InMemoryTokenServiceOptions = {},
): TokenService {
  const known = options.knownPluginIds !== undefined
    ? new Set(options.knownPluginIds)
    : undefined;
  const unsupported = new Set(options.unsupportedPluginIds ?? []);
  const tokenValue = options.tokenValue ?? 'stub-token';

  return {
    async generate(request): Promise<string> {
      if (known !== undefined && !known.has(request.pluginId)) {
        throw new UnknownPluginError(request.pluginId);
      }
      if (unsupported.has(request.pluginId)) {
        throw new TokenNotSupportedError(request.pluginId);
      }
      return tokenValue;
    },
  };
}
