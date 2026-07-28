import { loadConfig, getConfig } from './config/index.js';

/**
 * Composition root — Phase 0 Step 2 loads config; Step 3 adds Fastify listen.
 */
await loadConfig();
const config = getConfig();
console.info(
  `nxt-device-messaging: config loaded (engine.enabled=${ config.engine.enabled }, plugins=${ config.plugins.length })`,
);
