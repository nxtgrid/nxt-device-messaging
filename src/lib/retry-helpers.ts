/**
 * @fileoverview Retry logic utilities for device message delivery.
 *
 * Knobs come from the caller's `deliveryConfig` slice (ADR-002 §5) — no boot import.
 */

import type { DeliveryConfig } from '../config/schema.js';

/**
 * Calculate the delay before the next retry using exponential backoff.
 *
 * Formula: (backoffMultiplier ^ retryCount) * baseDelayMs, capped at maxDelayMs,
 * plus 0–50% jitter.
 *
 * Example delays with defaults (before jitter):
 * - Attempt 0 (first fail): 2^0 * 2000 = 2 seconds
 * - Attempt 1: 2^1 * 2000 = 4 seconds
 * - Attempt 2: 2^2 * 2000 = 8 seconds
 *
 * With defaults (11 retries, base 2s, ×2), ~1h 8m of retrying before jitter
 * (total attempts = maxRetries + 1).
 *
 * @param retryCount - Number of previous retry attempts (0 = first failure)
 * @param deliveryConfig - Shared delivery knobs from config
 * @returns Delay in milliseconds before next retry
 */
export const calculateBackoffDelay = (
  retryCount: number,
  deliveryConfig: DeliveryConfig,
): number => {
  const {
    retryBaseDelayMs,
    retryBackoffMultiplier,
    retryMaxDelayMs,
  } = deliveryConfig;

  const delay = retryBaseDelayMs * Math.pow(retryBackoffMultiplier, retryCount);
  const cappedDelay = Math.min(delay, retryMaxDelayMs);
  const jitter = Math.floor(Math.random() * (cappedDelay * 0.5));

  return cappedDelay + jitter;
};
