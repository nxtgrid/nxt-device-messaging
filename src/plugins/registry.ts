/**
 * @fileoverview Plugin registry — built once from config `plugins[]` (ADR-002 §6).
 *
 * Lookup-only after construction. Call from `runtime.ts` (or tests) with config entries;
 * do not import `runtime` from this module.
 *
 * Distribute resolves `queueKey → plugin` by parsing `pluginId` from
 * `queue:{pluginId}:{kind}:{id}` (ADR-006 D1) — no kind index here. Admission
 * execution is Unit 5.3 (D3).
 */

import type { DeviceMessagingConfig } from '../config/schema.js';
import type { PluginId } from '../lib/device-message/types.js';
import { PLUGIN_CATALOG } from './catalog.js';
import type { DeliveryPattern, DeviceMessagingPlugin } from './plugin.interface.js';

export type PluginRegistry = {
  /** Look up by plugin id. */
  get(id: PluginId): DeviceMessagingPlugin | undefined;
  /** All enabled plugins (config order). */
  getAll(): readonly DeviceMessagingPlugin[];
  /** Plugins matching a delivery pattern (e.g. PULL poll loop). */
  getByDeliveryPattern(pattern: DeliveryPattern): readonly DeviceMessagingPlugin[];
};

/**
 * Construct plugins listed in config and return a lookup-only registry.
 *
 * @throws If an entry id is unknown in {@link PLUGIN_CATALOG}, or the same id appears twice.
 */
export function createPluginRegistry(
  pluginEntries: DeviceMessagingConfig['plugins'],
): PluginRegistry {
  const plugins: Record<string, DeviceMessagingPlugin> = {};

  for (const entry of pluginEntries) {
    const factory = PLUGIN_CATALOG[entry.id];
    if (!factory) {
      const known = Object.keys(PLUGIN_CATALOG).join(', ');
      throw new Error(
        `Unknown plugin id "${ entry.id }". Known factories: ${ known || '(none)' }`,
      );
    }
    if (Object.hasOwn(plugins, entry.id)) {
      throw new Error(`Duplicate plugin id in config: ${ entry.id }`);
    }
    plugins[entry.id] = factory(entry);
  }

  return {
    get(id: PluginId): DeviceMessagingPlugin | undefined {
      return plugins[id];
    },

    getAll(): readonly DeviceMessagingPlugin[] {
      return Object.values(plugins);
    },

    getByDeliveryPattern(pattern: DeliveryPattern): readonly DeviceMessagingPlugin[] {
      return Object.values(plugins).filter(plugin => plugin.deliveryPattern === pattern);
    },
  };
}
