/**
 * @fileoverview Process boot — config + plugin registry as stable bindings.
 *
 * Import rule: only composition / engine / HTTP may import this module.
 * `lib/` helpers take the values they need as arguments (no boot import).
 *
 * Top-level await: importers wait until load + registry construction finish.
 */

import { loadConfig } from './config/load.js';
import { configureLogger } from './log.js';
import { createPluginRegistry } from './plugins/registry.js';

export { logger } from './log.js';

/** Frozen service config (ADR-002). */
export const config = await loadConfig();

configureLogger(config.logging);

/** Plugins enabled in config, constructed once at boot. */
export const pluginRegistry = createPluginRegistry(config.plugins);
