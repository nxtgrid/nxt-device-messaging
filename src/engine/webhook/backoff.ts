/**
 * @fileoverview Exponential backoff for outbound event-webhook HTTP retries.
 *
 * No jitter — locked first→last window (~62s with defaults) stays predictable.
 * Distinct from device-delivery {@link calculateBackoffDelay} (`delivery.*` + jitter).
 */

import type { EventWebhookConfig } from '../../config/schema.js';

/**
 * Delay before the next webhook HTTP attempt after a failure.
 *
 * @param failedAttemptCount - How many POSTs have already failed (1 after first fail)
 * @param webhookConfig - `eventWebhook` tuning
 * @returns Delay in ms (`baseDelayMs * multiplier^(failedAttemptCount - 1)`, capped)
 */
export function calculateWebhookBackoffDelay(
  failedAttemptCount: number,
  webhookConfig: Pick<
    EventWebhookConfig,
    'baseDelayMs' | 'backoffMultiplier' | 'maxDelayMs'
  >,
): number {
  const safeCount = Math.max(1, failedAttemptCount);
  const {
    baseDelayMs,
    backoffMultiplier,
    maxDelayMs,
  } = webhookConfig;
  const delay = baseDelayMs * Math.pow(backoffMultiplier, safeCount - 1);
  return Math.min(delay, maxDelayMs);
}
