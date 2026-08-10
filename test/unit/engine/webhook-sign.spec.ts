import { describe, expect, it } from 'vitest';

import {
  formatWebhookSignatureHeader,
  signWebhookBody,
  verifyWebhookSignature,
} from '#src/engine/webhook/sign.js';

describe('webhook HMAC helpers', () => {
  const secret = 'test-secret';
  const body = '{"eventId":"01EVENT","message":{}}';

  it('signs a stable hex digest', () => {
    const digest = signWebhookBody(secret, body);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(signWebhookBody(secret, body)).toBe(digest);
    expect(signWebhookBody('other', body)).not.toBe(digest);
  });

  it('formats and verifies the signature header', () => {
    const header = formatWebhookSignatureHeader(signWebhookBody(secret, body));
    expect(header.startsWith('sha256=')).toBe(true);
    expect(verifyWebhookSignature(secret, body, header)).toBe(true);
    expect(verifyWebhookSignature(secret, body, 'sha256=deadbeef')).toBe(false);
    expect(verifyWebhookSignature(secret, `${ body } `, header)).toBe(false);
  });
});
