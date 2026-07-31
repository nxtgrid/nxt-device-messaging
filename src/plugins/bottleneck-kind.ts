/**
 * @fileoverview Parse `queue:{bottleneckKind}:{id}` for registry lookup only (ADR-006 D1-B).
 *
 * Never use the extracted kind to choose admission or PUSH/PULL policy.
 */

/**
 * Extract `{bottleneckKind}` from a Redis initial-queue key.
 *
 * @param queueKey - Full key (`queue:{kind}:{id}`, id may contain `:`)
 * @returns The kind segment, or `undefined` if the key does not match the convention
 */
export function bottleneckKindFromQueueKey(queueKey: string): string | undefined {
  const separator = queueKey.indexOf(':');
  if (separator === -1) return undefined;

  const prefix = queueKey.slice(0, separator);
  if (prefix !== 'queue') return undefined;

  const rest = queueKey.slice(separator + 1);
  const kindEnd = rest.indexOf(':');
  if (kindEnd <= 0) return undefined;

  return rest.slice(0, kindEnd);
}
