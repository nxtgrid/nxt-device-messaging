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
    // Independent OpenSSL vector: echo -n '<body>' | openssl dgst -sha256 -hmac 'test-secret'
    expect(digest).toBe(
      'd12a8010f0f475e6b2390d0261b34bcb9e8186b42db678fe266cc6b1e9e5c70f',
    );
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
