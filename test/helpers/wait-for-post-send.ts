/**
 * @fileoverview Shared poll helper for Redis smokes waiting on post-send status.
 */

import type { OutgoingService } from '../../src/engine/outgoing.js';
import type { DeviceMessage } from '../../src/lib/device-message/types.js';
import { sleep } from '../../src/lib/utilities.js';

/** Status after successful sendOne + NS → next-stage move. */
export const POST_SEND_STATUS = 'DELIVERED_TO_NS' as const;

/**
 * Poll until fire-and-forget sendOne has moved the message past SENT_TO_NS.
 *
 * @param outgoingService - Outgoing surface (getByCorrelationId)
 * @param correlationId - Message correlation id
 * @param timeoutMs - Max wait (default 2s)
 */
export async function waitForPostSend(
  outgoingService: OutgoingService,
  correlationId: string,
  timeoutMs = 2_000,
): Promise<DeviceMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = await outgoingService.getByCorrelationId(correlationId);
    if (message?.deliveryStatus === POST_SEND_STATUS) return message;
    await sleep(20);
  }
  throw new Error(
    `Timed out waiting for ${ POST_SEND_STATUS } (correlationId=${ correlationId })`,
  );
}
