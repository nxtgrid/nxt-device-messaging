import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateRandomNumber } from '#src/plugins/_shared/generate-random-number.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('generateRandomNumber', () => {
  it('returns floor(random * max) in [0, max)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(generateRandomNumber(12)).toBe(6);
    expect(generateRandomNumber(1)).toBe(0);
  });

  it('returns 0 when Math.random is 0', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(generateRandomNumber(12)).toBe(0);
  });
});
