/**
 * @fileoverview Safe numeric coercion for vendor adapters.
 *
 * Port of `@helpers/number-helpers` `toSafeNumberOrNull` (frozen tiamat). Used by
 * CALIN plugin error/`ResultCode` paths; other plugins may share it.
 */

/**
 * Returns a function that converts a value to a finite number, or `fallback`.
 *
 * @param fallback - Value when coercion fails
 */
export function toSafeNumberOr<T>(fallback: T): (value: unknown) => number | T {
  return (value: unknown): number | T => {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : fallback;
    }

    if (typeof value === 'string') {
      if (value.trim() === '') {
        return fallback;
      }
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    }

    return fallback;
  };
}

/** Coerce to a finite number, or `null`. */
export const toSafeNumberOrNull = toSafeNumberOr<null>(null);
