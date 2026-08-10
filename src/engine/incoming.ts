/**
 * @fileoverview Incoming delivery surface: PUSH ingress + PULL poll + shared processing.
 *
 * Unit 5.5 — `handle` / thin HTTP (Step A) + `pollPullPlugins` (Step B).
 * Unit 5.6 — poll interval via `startEngineTimers`.
 */

import { isNotNil } from 'ramda';

import type { DeliveryConfig } from '../config/schema.js';
import { pollAwaitingTasksFor } from '../lib/lifecycle.pull.js';
import { QUEUE_DEVICE_KEY, moveQueuePush } from '../lib/queue-moving.push.js';
import { redisRepo } from '../lib/redis-repository/index.js';
import type {
  DeviceMessage,
  FailureReason,
  ParsedIncomingEvent,
} from '../lib/device-message/types.js';
import type { DeviceMessagingPlugin, IncomingHandleMeta } from '../plugins/plugin.interface.js';
import type { PluginRegistry } from '../plugins/registry.js';
import type { BaseService } from './base.js';

/**
 * Incoming operations used by HTTP (and later by the poll loop).
 * Wired at the composition root (`main.ts`); unit tests inject a fake.
 */
export type IncomingService = {
  /**
   * PUSH ingress: parse via `plugin.incoming.handle`, then process.
   * Caller (HTTP) already resolved an enabled PUSH plugin — no registry lookup here.
   * No-op when the plugin returns null (ignore event).
   */
  handle(
    event: unknown,
    plugin: DeviceMessagingPlugin,
    meta?: IncomingHandleMeta,
  ): Promise<void>;
  /**
   * One PULL poll tick: `fetchStatus` for due awaiting-task messages, then process.
   * Also driven by `startEngineTimers`; tests may invoke this directly.
   */
  pollPullPlugins(): Promise<void>;
};

/** Dependencies for {@link createIncomingService}. */
export type CreateIncomingServiceOptions = {
  readonly registry: PluginRegistry;
  readonly delivery: DeliveryConfig;
  /** Shared retry/requeue helpers — constructed at the composition root with peers. */
  readonly baseService: BaseService;
};

/**
 * Factory for PUSH ingress, PULL poll, and shared incoming-event processing.
 *
 * @param options - Registry, delivery knobs, and peer {@link BaseService}
 */
export function createIncomingService(options: CreateIncomingServiceOptions): IncomingService {
  const { registry, delivery, baseService } = options;

  /**
   * Process a parsed incoming event from PUSH (or later PULL poll).
   *
   * @param parsedEvent - Normalized event from the plugin
   * @param currentQueueKey - Queue for retry/fail (PUSH handle uses device queue)
   * @param plugin - Owning plugin (tuning for stage moves)
   */
  async function _processIncomingEvent(
    parsedEvent: ParsedIncomingEvent,
    currentQueueKey: string,
    plugin: DeviceMessagingPlugin,
  ): Promise<void> {
    const { deliveryQueueId, deliveryStatus, device, commandType, response, unsolicited, failureContext } = parsedEvent;

    // Device-initiated uplink with no matching outbound command.
    if (unsolicited) {
      baseService.emitDeliveryEvent({
        pluginId: plugin.id,
        commandType,
        deliveryStatus,
        device,
        response,
        unsolicited: true,
      });
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

    // Relay-node ACK (PUSH): move relay-node → device queue; no adopter event.
    if (deliveryStatus === 'SENT_TO_DEVICE') {
      await moveQueuePush.fromRelayNodeToDevice({
        id: messageId,
        tuning: plugin.tuning,
        messageTtlSeconds: delivery.messageTtlSeconds,
      });
      return;
    }

    if (deliveryStatus === 'DELIVERY_FAILED') {
      const context = failureContext ?? { reason: 'Unable to deliver message after negative remote response' };
      await baseService.retryOrFail(messageId, currentQueueKey, context);
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
    // Pick FailureReason fields only (do not spread FailureContext — it has skipRetry).
    if (failureContext) {
      const historyEntry: FailureReason = {
        timestamp: (new Date()).toISOString(),
        status: deliveryStatus,
        reason: failureContext.reason,
        ...(isNotNil(failureContext.errorCode) && { errorCode: failureContext.errorCode }),
        ...(failureContext.details && { details: failureContext.details }),
        isFinal: true,
      };
      updatedMessage.failureHistory = updatedMessage.failureHistory
        ? [ historyEntry, ...updatedMessage.failureHistory ]
        : [ historyEntry ];
    }

    baseService.emitDeliveryEvent(updatedMessage);
  }

  /**
   * PUSH pattern entry: parse raw webhook via the plugin, then process.
   *
   * @param event - Raw event payload from ingress
   * @param plugin - Already-resolved PUSH plugin (HTTP gated enablement / signature)
   * @param meta - Optional HTTP query/context (e.g. ChirpStack `?event=`)
   */
  async function handle(
    event: unknown,
    plugin: DeviceMessagingPlugin,
    meta?: IncomingHandleMeta,
  ): Promise<void> {
    const parse = plugin.incoming.handle;
    if (!parse) return;

    const parsedEvent = parse(event, meta);
    if (!parsedEvent) return;

    await _processIncomingEvent(parsedEvent, QUEUE_DEVICE_KEY, plugin);
  }

  /**
   * PULL pattern entry: poll each PULL plugin's awaiting-task queue for due messages.
   */
  async function pollPullPlugins(): Promise<void> {
    for (const plugin of registry.getByDeliveryPattern('PULL')) {
      const results = await pollAwaitingTasksFor(plugin);
      for (const { parsedEvent, queueKey } of results) {
        await _processIncomingEvent(parsedEvent, queueKey, plugin);
      }
    }
  }

  return { handle, pollPullPlugins };
}
