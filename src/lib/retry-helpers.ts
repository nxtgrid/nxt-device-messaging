/**
 * @fileoverview Retry logic utilities for device message delivery.
 *
 * Constants are config-backed via `delivery.*` (ADR-002 §5) with in-code defaults.
 */

import { getConfig } from '../config/index.js';

/**
 * Maximum number of retries before permanent failure.
 * Total attempts = maxRetries + 1 (the original try).
 * With defaults (11 retries, base 2s, ×2), ~1h 8m of retrying before jitter.
 */
export const getMaxRetries = (): number => getConfig().delivery.maxRetries;

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
 * @param retryCount - Number of previous retry attempts (0 = first failure)
 * @returns Delay in milliseconds before next retry
 */
export const calculateBackoffDelay = (retryCount: number): number => {
  const {
    retryBaseDelayMs,
    retryBackoffMultiplier,
    retryMaxDelayMs,
  } = getConfig().delivery;

  const delay = retryBaseDelayMs * Math.pow(retryBackoffMultiplier, retryCount);
  const cappedDelay = Math.min(delay, retryMaxDelayMs);
  const jitter = Math.floor(Math.random() * (cappedDelay * 0.5));

  return cappedDelay + jitter;
};
