/**
 * @fileoverview Incoming delivery surface: PUSH ingress handle + shared event processing.
 *
 * Unit 5.5 Step A — `handle` + thin HTTP. `pollPullPlugins` lands in Step B.
 * Timer / resolution-cycle wiring lands in Unit 5.6.
 */

import type { DeliveryConfig } from '../config/schema.js';
import { QUEUE_DEVICE_KEY, moveQueuePush } from '../lib/queue-moving.push.js';
import { redisRepo } from '../lib/redis-repository/index.js';
import type { DeviceMessage, ParsedIncomingEvent } from '../lib/device-message/types.js';
import type { DeviceMessagingPlugin } from '../plugins/plugin.interface.js';
import type { PluginRegistry } from '../plugins/registry.js';
import { emitDeliveryEvent, type Base } from './base.js';

/**
 * Incoming operations used by HTTP (and later by the poll loop).
 * Wired at the composition root (`main.ts`); unit tests inject a fake.
 */
export type Incoming = {
  /**
   * PUSH ingress: parse via `plugin.incoming.handle`, then process.
   * Caller (HTTP) already resolved an enabled PUSH plugin — no registry lookup here.
   * No-op when the plugin returns null (ignore event).
   */
  handle(event: unknown, plugin: DeviceMessagingPlugin): Promise<void>;
};

/** Dependencies for {@link createIncoming}. */
export type CreateIncomingOptions = {
  /** Kept for Step B (`pollPullPlugins`); unused by `handle`. */
  readonly registry: PluginRegistry;
  readonly delivery: DeliveryConfig;
  /** Shared retry/requeue helpers — constructed at the composition root with peers. */
  readonly base: Base;
};

/**
 * Factory for PUSH ingress + shared incoming-event processing.
 *
 * @param options - Registry (Step B), delivery knobs, and peer {@link Base}
 */
export function createIncoming(options: CreateIncomingOptions): Incoming {
  const { delivery, base } = options;

  /**
   * Process a parsed incoming event from PUSH (or later PULL poll).
   *
   * @param parsedEvent - Normalized event from the plugin
   * @param currentQueueKey - Queue for retry/fail (PUSH handle uses device queue)
   */
  async function _processIncomingEvent(parsedEvent: ParsedIncomingEvent, currentQueueKey: string): Promise<void> {
    const { deliveryQueueId, deliveryStatus, device, commandType, response, unsolicited, failureContext } = parsedEvent;

    // Device-initiated uplink with no matching outbound command.
    if (unsolicited) {
      emitDeliveryEvent({ commandType, deliveryStatus, device, response, unsolicited: true });
      return;
    }

    if (!deliveryQueueId) {
      console.warn('[incoming] No deliveryQueueId', parsedEvent);
      return;
    }

    const messageId = await redisRepo.getMessageIdFromDeliveryQueueId(deliveryQueueId);
    if (!messageId) {
      console.warn(`[incoming] Can't find message for deliveryQueueId ${ deliveryQueueId }`, parsedEvent);
      return;
    }

    // Gateway ACK (PUSH): move GW → device queue; no adopter event.
    if (deliveryStatus === 'SENT_TO_DEVICE') {
      await moveQueuePush.fromGwToDevice({ id: messageId, deliveryConfig: delivery });
      return;
    }

    if (deliveryStatus === 'DELIVERY_FAILED') {
      const context = failureContext ?? { reason: 'Unable to deliver message after negative remote response' };
      await base.retryOrFail(messageId, currentQueueKey, context);
      return;
    }

    if (deliveryStatus !== 'DELIVERY_SUCCESSFUL') {
      console.warn(`[incoming] Unexpected delivery status ${ deliveryStatus }`, parsedEvent);
      return;
    }

    const storedMessage = await redisRepo.getMessageById(messageId);
    if (!storedMessage) {
      console.warn(`[incoming] Message not found (already cleaned up?): ${ messageId }`);
      return;
    }

    await redisRepo.messageFullCleanup(storedMessage);

    const updatedMessage: DeviceMessage = { ...storedMessage, deliveryStatus, response, device };

    // Successful delivery can still carry a failed execution — keep failure history.
    if (failureContext) {
      const completeFailureContext = {
        timestamp: (new Date()).toISOString(),
        status: deliveryStatus,
        isFinal: true,
        ...failureContext,
      };
      updatedMessage.failureHistory = updatedMessage.failureHistory
        ? [ completeFailureContext, ...updatedMessage.failureHistory ]
        : [ completeFailureContext ];
    }

    emitDeliveryEvent(updatedMessage);
  }

  /**
   * PUSH pattern entry: parse raw webhook via the plugin, then process.
   *
   * @param event - Raw event payload from ingress
   * @param plugin - Already-resolved PUSH plugin (HTTP gated enablement / signature)
   */
  async function handle(event: unknown, plugin: DeviceMessagingPlugin): Promise<void> {
    const parse = plugin.incoming.handle;
    if (!parse) return;

    const parsedEvent = parse(event);
    if (!parsedEvent) return;

    await _processIncomingEvent(parsedEvent, QUEUE_DEVICE_KEY);
  }

  return { handle };
}
