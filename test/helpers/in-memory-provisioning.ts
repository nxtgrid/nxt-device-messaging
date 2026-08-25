/**
 * @fileoverview In-memory {@link ProvisioningService} for HTTP unit tests.
 */

import {
  InvalidProvisioningError,
  ProvisioningNotSupportedError,
  UnknownPluginError,
} from '#src/engine/errors.js';
import type { ProvisioningService } from '#src/engine/provisioning.js';
import type { PluginId } from '#src/lib/device-message/types.js';

export type InMemoryProvisioningServiceOptions = {
  /** Plugin ids that accept execute (default: all). */
  readonly knownPluginIds?: readonly PluginId[];
  /** Plugin ids that are known but have no provisioning facet. */
  readonly unsupportedPluginIds?: readonly PluginId[];
  /** Fixed result returned on success (default `{ ok: true }`). */
  readonly result?: unknown;
};

/** Process-local provisioning surface for route / app unit tests. */
export function createInMemoryProvisioningService(
  options: InMemoryProvisioningServiceOptions = {},
): ProvisioningService {
  const known = options.knownPluginIds !== undefined
    ? new Set(options.knownPluginIds)
    : undefined;
  const unsupported = new Set(options.unsupportedPluginIds ?? []);
  const result = options.result ?? { ok: true };

  return {
    async execute(request): Promise<unknown> {
      if (known !== undefined && !known.has(request.pluginId)) {
        throw new UnknownPluginError(request.pluginId);
      }
      if (unsupported.has(request.pluginId)) {
        throw new ProvisioningNotSupportedError(request.pluginId);
      }
      if (request.operation === 'invalid') {
        throw new InvalidProvisioningError(request.pluginId, 'unsupported operation: invalid');
      }
      return result;
    },
  };
}
