/**
 * @fileoverview Shared required-env loader for plugin secrets (ADR-002 §2 / §6).
 *
 * Plugins keep their key lists and camelCase secret maps; this helper only
 * reads `process.env`, trims, and fails with a consistent `MISSING` message.
 */

/**
 * Read required env keys from `process.env`.
 *
 * Values are trimmed. Blank / whitespace-only counts as missing.
 *
 * @param pluginId - Plugin id for the error message
 * @param keys - Required environment variable names
 * @returns Map of each key to its trimmed value
 * @throws If any key is missing or blank (`MISSING env for plugin "…"…`)
 */
export function requireEnvKeys<K extends string>(
  pluginId: string,
  keys: readonly K[],
): Record<K, string> {
  const values = {} as Record<K, string>;
  const missing: K[] = [];

  for (const key of keys) {
    const value = process.env[key];
    const trimmed = value?.trim();
    if (trimmed === undefined || trimmed === '') {
      missing.push(key);
    }
    else {
      values[key] = trimmed;
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `MISSING env for plugin "${ pluginId }": ${ missing.join(', ') }`,
    );
  }

  return values;
}
