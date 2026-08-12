/**
 * @fileoverview Opt-in HMAC-SHA256 signing for outbound event webhooks (ADR-003 §6).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Request header carrying `sha256=<hex>` over the raw body. */
export const WEBHOOK_SIGNATURE_HEADER = 'X-Device-Messaging-Signature';

/** Request header repeating `eventId` for idempotent consumer handling. */
export const WEBHOOK_EVENT_ID_HEADER = 'X-Device-Messaging-Event-Id';

/**
 * HMAC-SHA256 hex digest of the raw POST body.
 *
 * @param secret - Shared webhook secret (`DEVICE_MESSAGING_WEBHOOK_SECRET`)
 * @param rawBody - Exact JSON string that will be sent as the body
 */
export function signWebhookBody(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/**
 * Format the signature header value (`sha256=<hex>`).
 *
 * @param hexDigest - Output of {@link signWebhookBody}
 */
export function formatWebhookSignatureHeader(hexDigest: string): string {
  return `sha256=${ hexDigest }`;
}

/**
 * Verify a signature header against a raw body (consumer-side helper / tests).
 *
 * @param secret - Shared webhook secret
 * @param rawBody - Exact received body bytes as utf8 string
 * @param signatureHeader - Value of {@link WEBHOOK_SIGNATURE_HEADER}
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string,
): boolean {
  const expected = formatWebhookSignatureHeader(signWebhookBody(secret, rawBody));
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(signatureHeader, 'utf8');
  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, actualBuf);
}
