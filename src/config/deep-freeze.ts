/**
 * Recursively freezes a plain object or array tree. Intended for JSON-derived config values where
 * nested objects must be immutable, not just the root.
 */
export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return value;
  }
  seen.add(value);

  for (const key of Reflect.ownKeys(value)) {
    const nested = (value as Record<PropertyKey, unknown>)[key];
    if (nested !== null && typeof nested === 'object') {
      deepFreeze(nested, seen);
    }
  }

  return Object.freeze(value);
}
