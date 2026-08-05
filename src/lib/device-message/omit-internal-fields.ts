/**
 * @fileoverview Drop process-only message fields before public wire payloads.
 */

import type { DeviceMessage } from './types.js';

/**
 * Omit fields that exist only for the delivery engine (e.g. admission track key)
 * before command API responses or outbound delivery events. Does not mutate the input.
 *
 * @param message - Stored or partial device message
 */
export function omitInternalFields<T extends Partial<DeviceMessage>>(message: T): T {
  if (message.concurrencyRateLimitKey === undefined) {
    return message;
  }
  const copy = { ...message };
  delete copy.concurrencyRateLimitKey;
  return copy;
}
