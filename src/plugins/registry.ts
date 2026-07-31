/**
 * @fileoverview Plugin registry — built once from config `plugins[]` (ADR-002 §6).
 *
 * Lookup-only after construction. Call from `runtime.ts` (or tests) with config entries;
 * do not import `runtime` from this module.
 *
 * `queueKey → plugin` via boot-time `bottleneckKind` map (ADR-006 D1-B). Admission
 * execution is Unit 5.3 (D3).
 */

import type { DeviceMessagingConfig } from '../config/schema.js';
import type { PluginId } from '../lib/device-message/types.js';
import { PLUGIN_CATALOG } from './catalog.js';
import type { DeliveryPattern, DeviceMessagingPlugin } from './plugin.interface.js';

export type PluginRegistry = {
  /** Look up by plugin id. */
  get(id: PluginId): DeviceMessagingPlugin | undefined;
  /** Look up by bottleneck kind (`queue:{kind}:{id}` middle segment). */
  getByBottleneckKind(kind: string): DeviceMessagingPlugin | undefined;
  /** All enabled plugins (config order). */
  getAll(): readonly DeviceMessagingPlugin[];
  /** Plugins matching a delivery pattern (e.g. PULL poll loop). */
  getByDeliveryPattern(pattern: DeliveryPattern): readonly DeviceMessagingPlugin[];
};

/**
 * Construct plugins listed in config and return a lookup-only registry.
 *
 * @throws If an entry id is unknown in {@link PLUGIN_CATALOG}, the same id appears
 *   twice, or two enabled plugins share the same {@link DeviceMessagingPlugin.bottleneckKind}.
 */
export function createPluginRegistry(
  pluginEntries: DeviceMessagingConfig['plugins'],
): PluginRegistry {
  const plugins: Record<string, DeviceMessagingPlugin> = {};
  const byKind: Record<string, DeviceMessagingPlugin> = {};

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

    const plugin = factory(entry);
    if (Object.hasOwn(byKind, plugin.bottleneckKind)) {
      const owner = byKind[plugin.bottleneckKind];
      throw new Error(`Duplicate bottleneckKind "${ plugin.bottleneckKind }" for plugins "${ owner.id }" and "${ plugin.id }" (Registry requires unique kinds)`);
    }

    plugins[entry.id] = plugin;
    byKind[plugin.bottleneckKind] = plugin;
  }

  return {
    get(id: PluginId): DeviceMessagingPlugin | undefined {
      return plugins[id];
    },

    getByBottleneckKind(kind: string): DeviceMessagingPlugin | undefined {
      return byKind[kind];
    },

    getAll(): readonly DeviceMessagingPlugin[] {
      return Object.values(plugins);
    },

    getByDeliveryPattern(pattern: DeliveryPattern): readonly DeviceMessagingPlugin[] {
      return Object.values(plugins).filter(plugin => plugin.deliveryPattern === pattern);
    },
  };
}
