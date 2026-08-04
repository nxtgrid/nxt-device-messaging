/**
 * @fileoverview Initial-queue Redis key helpers (ADR-006).
 *
 * Shape: `queue:{pluginId}:{kind}:{id}`
 * - `pluginId` — owning plugin; distribute parses this for lookup only
 * - `kind` — human label for the admission node (network, relayNode (gateway, dcu, ...) …)
 * - `id` — instance of that node (`42`, `unassigned`, …)
 *
 * Admission policy is **not** inferred from `kind` — that lives on `plugin.admission`.
 * Concurrency rate-limit keys reuse the same `{pluginId}:{kind}:{id}` identity
 * ({@link buildConcurrencyRateLimitKey}).
 */

/**
 * Build a Redis initial-queue key. Plugins should use this rather than freestyle strings
 * so `pluginId` is always in a fixed position for distribute.
 *
 * @param pluginId - Owning plugin id (must match the plugin's `id`)
 * @param kind - Human-readable admission-node label (not used for policy)
 * @param id - Admission-node instance id (`unassigned` when applicable)
 */
export function buildInitialQueueKey(
  pluginId: string,
  kind: string,
  id: string,
): string {
  return `queue:${ pluginId }:${ kind }:${ id }`;
}

/**
 * Extract `pluginId` from an initial-queue key for registry lookup.
 *
 * @param queueKey - Initial-queue Redis key (`queue:{pluginId}:{kind}:{id}`)
 * @returns The plugin id, or `undefined` if the key does not match the convention
 */
export function getPluginIdFromInitialQueueKey(queueKey: string): string | undefined {
  const parts = queueKey.split(':');
  if (parts.length < 4 || parts[0] !== 'queue' || parts[1] === '') {
    return undefined;
  }
  return parts[1];
}

/**
 * Derive the concurrency strategy's rate-limit Redis key from an initial-queue key.
 *
 * The admission node is already identified by the queue partition, so plugins do not
 * supply a separate key builder. Shape:
 * `queue:{pluginId}:{kind}:{id}` → `rate_limit:{pluginId}:{kind}:{id}`.
 *
 * Pass the result to Redis helpers / cleanup as `concurrencyRateLimitKey`.
 *
 * @param queueKey - Initial-queue Redis key (`queue:{pluginId}:{kind}:{id}`)
 * @returns The rate-limit key, or `undefined` if `queueKey` is not a valid initial-queue key
 */
export function buildConcurrencyRateLimitKey(queueKey: string): string | undefined {
  const parts = queueKey.split(':');
  if (parts.length < 4 || parts[0] !== 'queue' || parts[1] === '') {
    return undefined;
  }
  return `rate_limit:${ parts.slice(1).join(':') }`;
}
