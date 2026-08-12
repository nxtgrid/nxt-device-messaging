import { describe, expect, it } from 'vitest';

import { calculateWebhookBackoffDelay } from '#src/engine/webhook/backoff.js';

const DEFAULTS = {
  baseDelayMs: 2000,
  backoffMultiplier: 2,
  maxDelayMs: 60_000,
} as const;

describe('calculateWebhookBackoffDelay', () => {
  it('matches the locked ~62s ladder (2+4+8+16+32)', () => {
    expect(calculateWebhookBackoffDelay(1, DEFAULTS)).toBe(2000);
    expect(calculateWebhookBackoffDelay(2, DEFAULTS)).toBe(4000);
    expect(calculateWebhookBackoffDelay(3, DEFAULTS)).toBe(8000);
    expect(calculateWebhookBackoffDelay(4, DEFAULTS)).toBe(16_000);
    expect(calculateWebhookBackoffDelay(5, DEFAULTS)).toBe(32_000);
  });

  it('caps at maxDelayMs', () => {
    expect(calculateWebhookBackoffDelay(10, DEFAULTS)).toBe(60_000);
  });

  it('treats failedAttemptCount < 1 as the first failure delay', () => {
    expect(calculateWebhookBackoffDelay(0, DEFAULTS)).toBe(2000);
  });
});
