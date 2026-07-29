/**
 * @fileoverview In-memory plugin registry (pre–Unit 5).
 *
 * Only plugins present in config are constructed and registered at boot (ADR-002 §6).
 * This module does not read config or construct plugins — the composition root will.
 *
 * No `queueKey → pluginId` map here (D1 — Unit 5). No admission execution (D3 — Unit 5).
 */

import type { DeliveryPattern, DeviceMessagingPlugin } from './plugin.interface.js';
import type { PluginId } from './types.js';

export type PluginRegistry = {
  /** Register a plugin. Throws if `id` is already taken. */
  register(plugin: DeviceMessagingPlugin): void;
  /** Look up by plugin id. */
  get(id: PluginId): DeviceMessagingPlugin | undefined;
  /** All registered plugins (insertion order). */
  getAll(): readonly DeviceMessagingPlugin[];
  /** Plugins matching a delivery pattern (e.g. PULL poll loop). */
  getByDeliveryPattern(pattern: DeliveryPattern): readonly DeviceMessagingPlugin[];
  /** Remove all registrations (tests / reboot). */
  clear(): void;
};

/**
 * Create an empty plugin registry.
 */
export function createPluginRegistry(): PluginRegistry {
  const plugins = new Map<PluginId, DeviceMessagingPlugin>();

  return {
    register(plugin: DeviceMessagingPlugin): void {
      if (plugins.has(plugin.id)) {
        throw new Error(`Plugin already registered: ${ plugin.id }`);
      }
      plugins.set(plugin.id, plugin);
    },

    get(id: PluginId): DeviceMessagingPlugin | undefined {
      return plugins.get(id);
    },

    getAll(): readonly DeviceMessagingPlugin[] {
      return [ ...plugins.values() ];
    },

    getByDeliveryPattern(pattern: DeliveryPattern): readonly DeviceMessagingPlugin[] {
      return [ ...plugins.values() ].filter(plugin => plugin.deliveryPattern === pattern);
    },

    clear(): void {
      plugins.clear();
    },
  };
}

/** Process-wide registry. Composition root registers enabled plugins at boot. */
export const pluginRegistry: PluginRegistry = createPluginRegistry();
