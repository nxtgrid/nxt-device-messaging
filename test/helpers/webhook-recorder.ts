/**
 * @fileoverview Recording stand-in for the outbound webhook messenger.
 *
 * Terminal paths persist an adopter event *before* dropping the message hash, so a
 * spec that only checks Redis cannot tell "cleaned up" from "cleaned up silently".
 * This captures what would have been sent, without a webhook store or an HTTP server.
 */

import type { WebhookService } from '#src/engine/webhook/service.js';
import type {
  DeviceMessage,
  DeviceMessageDeliveryStatus,
} from '#src/lib/device-message/types.js';

export type WebhookRecorder = {
  /** Events in emit order. */
  readonly events: Array<Partial<DeviceMessage>>;
  /** Pass as `webhook` to {@link createBaseService}. */
  readonly webhook: Pick<WebhookService, 'storeAndEmit'>;
  /** Events whose delivery status matches, in emit order. */
  withStatus(status: DeviceMessageDeliveryStatus): Array<Partial<DeviceMessage>>;
};

/** Capture adopter notifications instead of persisting and POSTing them. */
export function createWebhookRecorder(): WebhookRecorder {
  const events: Array<Partial<DeviceMessage>> = [];

  return {
    events,
    webhook: {
      async storeAndEmit(message: Partial<DeviceMessage>): Promise<void> {
        events.push(message);
      },
    },
    withStatus(status: DeviceMessageDeliveryStatus) {
      return events.filter(event => event.deliveryStatus === status);
    },
  };
}
