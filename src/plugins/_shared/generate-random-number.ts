/**
 * @fileoverview Random integer helper for vendor adapters.
 *
 * Port of `@helpers/utilities` `generateRandomNumber` (frozen tiamat).
 * Returns `Math.floor(Math.random() * max)` — for `max === 12` that is **0..11**,
 * not a 12-digit integer. Callers that need that legacy behaviour should pass
 * the same `max` as production.
 */

/**
 * Generate a random integer in `[0, max)`.
 *
 * @param max - Exclusive upper bound (must be positive)
 */
export function generateRandomNumber(max: number): number {
  return Math.floor(Math.random() * max);
}
