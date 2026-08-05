import { describe, expect, it } from 'vitest';

import {
  toSafeNumberOr,
  toSafeNumberOrNull,
} from '#src/plugins/_shared/to-safe-number-or-null.js';

describe('toSafeNumberOrNull', () => {
  it('keeps finite numbers', () => {
    expect(toSafeNumberOrNull(42)).toBe(42);
    expect(toSafeNumberOrNull(0)).toBe(0);
  });

  it('parses numeric strings', () => {
    expect(toSafeNumberOrNull('503')).toBe(503);
  });

  it('returns null for non-finite or non-numeric input', () => {
    expect(toSafeNumberOrNull(Number.NaN)).toBeNull();
    expect(toSafeNumberOrNull('')).toBeNull();
    expect(toSafeNumberOrNull('  ')).toBeNull();
    expect(toSafeNumberOrNull('nope')).toBeNull();
    expect(toSafeNumberOrNull(undefined)).toBeNull();
    expect(toSafeNumberOrNull(null)).toBeNull();
    expect(toSafeNumberOrNull({})).toBeNull();
  });
});

describe('toSafeNumberOr', () => {
  it('uses the provided fallback', () => {
    const toZero = toSafeNumberOr(0);
    expect(toZero('x')).toBe(0);
    expect(toZero('9')).toBe(9);
  });
});
