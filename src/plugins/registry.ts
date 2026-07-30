/**
 * @fileoverview Plugin registry — built once from config `plugins[]` (ADR-002 §6).
 *
 * Lookup-only after construction. No empty-then-register happy path.
 * Process-wide store mirrors config (`setPluginRegistry` / `getPluginRegistry`).
 *
 * No `queueKey → pluginId` map here (D1 — Unit 5). No admission execution (D3 — Unit 5).
 */

import { PLUGIN_CATALOG } from './catalog.js';
import type { DeliveryPattern, DeviceMessagingPlugin } from './plugin.interface.js';
import type { DeviceMessagingConfig } from '../config/schema.js';
import type { PluginId } from '../lib/types.js';

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

let currentRegistry: PluginRegistry | undefined;

/**
 * Stores the active registry. Used by the composition root after
 * {@link createPluginRegistry}, and by tests as `setPluginRegistry(...)`.
 */
export function setPluginRegistry(registry: PluginRegistry): void {
  currentRegistry = registry;
}

/**
 * Returns the active registry. Throws if called before boot (or test) setup.
 */
export function getPluginRegistry(): PluginRegistry {
  if (currentRegistry === undefined) {
    throw new Error(
      'getPluginRegistry() was called before plugins were loaded. Call createPluginRegistry() + setPluginRegistry() in main.ts (or setPluginRegistry() in tests) first.',
    );
  }
  return currentRegistry;
}
