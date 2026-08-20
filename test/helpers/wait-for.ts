/**
 * @fileoverview Polling waits for fire-and-forget engine work.
 *
 * `distributeToNetworkServers` hands off to `sendOne` without awaiting it, so a spec
 * cannot assert on the post-send state synchronously. These wait on the observable
 * effect instead of sleeping a guessed interval.
 */

import type { OutgoingService } from '#src/engine/outgoing.js';
import type {
  DeviceMessage,
  DeviceMessageDeliveryStatus,
} from '#src/lib/device-message/types.js';
import { sleep } from '#src/lib/utilities.js';

const POLL_INTERVAL_MS = 20;
const DEFAULT_TIMEOUT_MS = 2_000;

/**
 * Wait until the message reaches one of `statuses`.
 *
 * @param outgoingService - Outgoing surface (`getByCorrelationId`)
 * @param correlationId - Message correlation id
 * @param statuses - Acceptable delivery statuses
 * @param timeoutMs - Max wait before throwing
 */
export async function waitForDeliveryStatus(
  outgoingService: OutgoingService,
  correlationId: string,
  statuses: readonly DeviceMessageDeliveryStatus[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<DeviceMessage> {
  const deadline = Date.now() + timeoutMs;
  let last: DeviceMessageDeliveryStatus | 'absent' = 'absent';

  while (Date.now() < deadline) {
    const message = await outgoingService.getByCorrelationId(correlationId);
    last = message?.deliveryStatus ?? 'absent';
    if (message && statuses.includes(message.deliveryStatus)) return message;
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timed out waiting for ${ statuses.join('|') } (correlationId=${ correlationId }, last=${ last })`,
  );
}

/**
 * Wait until the message hash is gone — the observable end of a terminal path.
 *
 * @param outgoingService - Outgoing surface (`getByCorrelationId`)
 * @param correlationId - Message correlation id
 * @param timeoutMs - Max wait before throwing
 */
export async function waitForMessageGone(
  outgoingService: OutgoingService,
  correlationId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await outgoingService.getByCorrelationId(correlationId) === null) return;
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for cleanup (correlationId=${ correlationId })`);
}
