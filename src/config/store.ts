import type { DeviceMessagingConfig } from './schema.js';

let currentConfig: DeviceMessagingConfig | undefined;

/**
 * Stores the active configuration. Used internally by {@link loadConfig} after validation, and
 * directly by tests as the `setConfig(testConfig)` override pattern (ADR-002 §4).
 */
export function setConfig(config: DeviceMessagingConfig): void {
  currentConfig = config;
}

/**
 * Returns the active configuration. Throws if called before {@link loadConfig} (or
 * `setConfig()` in tests) has run — there is no implicit default (ADR-002 §4).
 */
export function getConfig(): DeviceMessagingConfig {
  if (currentConfig === undefined) {
    throw new Error(
      'getConfig() was called before configuration was loaded. Call loadConfig() in main.ts (or setConfig() in tests) first.',
    );
  }
  return currentConfig;
}
