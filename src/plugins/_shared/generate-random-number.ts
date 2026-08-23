/**
 * @fileoverview Random integer helper for vendor adapters.
 *
 * Returns `Math.floor(Math.random() * max)` — for `max === 12` that is **0..11**,
 * not a 12-digit integer. Callers that need a 12-digit integer should not use
 * this helper.
 */

/**
 * Generate a random integer in `[0, max)`.
 *
 * @param max - Exclusive upper bound (must be positive)
 */
export function generateRandomNumber(max: number): number {
  return Math.floor(Math.random() * max);
}
