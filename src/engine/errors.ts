/**
 * @fileoverview Shared domain errors for engine → HTTP mapping.
 */

import type { PluginId } from '../lib/device-message/types.js';

/**
 * Thrown when a request names a plugin that is not registered / enabled.
 * HTTP maps this to 400.
 */
export class UnknownPluginError extends Error {
  readonly pluginId: PluginId;

  constructor(pluginId: PluginId) {
    super(`Unknown or disabled pluginId: ${ pluginId }`);
    this.name = 'UnknownPluginError';
    this.pluginId = pluginId;
  }
}

/**
 * Thrown when a plugin is enabled but does not expose `token.generate`.
 * HTTP maps this to 400.
 */
export class TokenNotSupportedError extends Error {
  readonly pluginId: PluginId;

  constructor(pluginId: PluginId) {
    super(`Plugin does not support token generation: ${ pluginId }`);
    this.name = 'TokenNotSupportedError';
    this.pluginId = pluginId;
  }
}
