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

/**
 * Thrown when a plugin is enabled but does not expose `provisioning.execute`.
 * HTTP maps this to 400.
 */
export class ProvisioningNotSupportedError extends Error {
  readonly pluginId: PluginId;

  constructor(pluginId: PluginId) {
    super(`Plugin does not support provisioning: ${ pluginId }`);
    this.name = 'ProvisioningNotSupportedError';
    this.pluginId = pluginId;
  }
}

/**
 * Thrown when the operation name or payload is not valid for the plugin.
 * HTTP maps this to 400.
 */
export class InvalidProvisioningError extends Error {
  readonly pluginId: PluginId;

  constructor(pluginId: PluginId, detail: string) {
    super(`Plugin ${ pluginId }: ${ detail }`);
    this.name = 'InvalidProvisioningError';
    this.pluginId = pluginId;
  }
}

/**
 * Thrown when the plugin is enabled but does not accept `commandType`.
 * HTTP maps this to 400 (ADR-003 §4).
 */
export class UnsupportedCommandTypeError extends Error {
  readonly pluginId: PluginId;
  readonly commandType: string;

  constructor(pluginId: PluginId, commandType: string) {
    super(`Plugin ${ pluginId } does not support commandType: ${ commandType }`);
    this.name = 'UnsupportedCommandTypeError';
    this.pluginId = pluginId;
    this.commandType = commandType;
  }
}

/**
 * Thrown when enqueue input fails a plugin-local requirement (e.g. missing
 * `device.relayNode.id`). HTTP maps this to 400.
 */
export class InvalidEnqueueError extends Error {
  readonly pluginId: PluginId;

  constructor(pluginId: PluginId, detail: string) {
    super(`Plugin ${ pluginId }: ${ detail }`);
    this.name = 'InvalidEnqueueError';
    this.pluginId = pluginId;
  }
}
