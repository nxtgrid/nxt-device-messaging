import { describe, expect, it } from 'vitest';

import { webhookRedisKeys } from '#src/engine/webhook/keys.js';

describe('webhookRedisKeys', () => {
  it('uses the webhook: prefix and locked shapes', () => {
    expect(webhookRedisKeys.pending()).toBe('webhook:pending');
    expect(webhookRedisKeys.payload('01EVENT')).toBe('webhook:payload:01EVENT');
    expect(webhookRedisKeys.deadLetter('01EVENT')).toBe('webhook:dlq:01EVENT');
  });
});
