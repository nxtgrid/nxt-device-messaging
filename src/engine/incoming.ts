/**
 * @fileoverview Incoming delivery surface: PUSH ingress + shared event processing.
 *
 * Both delivery patterns end up here — a webhook the network server pushed at us, and a
 * status the `awaitingTask` action pulled from a vendor, are the same event once parsed.
 */

import { isNotNil } from 'ramda';

import type {
  DeviceMessage,
  FailureReason,
  ParsedIncomingEvent,
} from '../lib/device-message/types.js';
import type { MessageStore } from '../lib/redis-repository/message-store.js';
import { logger } from '../log.js';
import type { MetricsRecorder } from '../metrics/index.js';
import type {
  DeliveryPlugin,
  IncomingHandleMeta,
  PushPlugin,
} from '../plugins/plugin.interface.js';
import type { BaseService } from './base.js';
import type { StageMoves } from './lifecycle/moves.js';
import { STAGES } from './lifecycle/stages.js';
import type { StageOutcome } from './lifecycle/types.js';

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
    plugin: PushPlugin,
    meta?: IncomingHandleMeta,
  ): Promise<void>;
  /**
   * Apply one parsed event to the message it refers to: advance, retry, or resolve.
   *
   * Shared by PUSH ingress and the `awaitingTask` poll, which is why it reports a
   * {@link StageOutcome} — the poll runs inside the stage runner and the runner owes the
   * member either a new score or a removal.
   *
   * @param parsedEvent - Normalized event from the plugin
   * @param currentQueueKey - Queue the message sits in (the caller's stage)
   * @param plugin - Owning delivery plugin
   */
  processEvent(
    parsedEvent: ParsedIncomingEvent,
    currentQueueKey: string,
    plugin: DeliveryPlugin,
  ): Promise<StageOutcome>;
};

/** Dependencies for {@link createIncomingService}. */
export type CreateIncomingServiceOptions = {
  /** Shared retry/requeue helpers — constructed at the composition root with peers. */
  readonly baseService: BaseService;
  readonly messageStore: MessageStore;
  readonly moves: StageMoves;
  readonly metrics: MetricsRecorder;
};

/**
 * Factory for PUSH ingress and shared incoming-event processing.
 *
 * Polling is not here: the `awaitingTask` stage action drives it (ADR-008 §3), and calls
 * back into {@link IncomingService.processEvent} with whatever the vendor returned.
 *
 * @param options - Peer {@link BaseService}, message store, moves, metrics
 */
export function createIncomingService(options: CreateIncomingServiceOptions): IncomingService {
  const { baseService, messageStore, moves, metrics } = options;

  /**
   * Process a parsed incoming event from PUSH ingress or the `awaitingTask` poll.
   *
   * Every branch that changes nothing about the member reports `rescheduled`: from the
   * runner's side "this event told us nothing new" and "keep waiting" are the same
   * statement, and returning it is what stops an unresolvable event from spinning the
   * stage on every tick (A2).
   *
   * @param parsedEvent - Normalized event from the plugin
   * @param currentQueueKey - Queue for retry/fail (PUSH handle uses the device queue)
   * @param plugin - Owning delivery plugin (tuning for stage moves)
   */
  async function processEvent(
    parsedEvent: ParsedIncomingEvent,
    currentQueueKey: string,
    plugin: DeliveryPlugin,
  ): Promise<StageOutcome> {
    const { deliveryQueueId, deliveryStatus, device, commandType, response, unsolicited, failureContext } = parsedEvent;

    // Device-initiated uplink with no matching outbound command.
    if (unsolicited) {
      await baseService.emitDeliveryEvent({
        pluginId: plugin.id,
        commandType,
        deliveryStatus,
        device,
        response,
        unsolicited: true,
      });
      return 'rescheduled';
    }

    if (!deliveryQueueId) {
      logger.warn({ module: 'incoming', parsedEvent }, 'no deliveryQueueId');
      return 'rescheduled';
    }

    const messageId = await messageStore.getMessageIdFromDeliveryQueueId(deliveryQueueId);
    if (!messageId) {
      logger.warn({ module: 'incoming', deliveryQueueId, parsedEvent }, 'message not found for deliveryQueueId');
      return 'orphaned';
    }

    // Relay-node ACK (PUSH): move relay-node → device queue; no adopter event.
    if (deliveryStatus === 'SENT_TO_DEVICE' && plugin.deliveryPattern === 'PUSH') {
      await moves.advance({ messageId, plugin, from: 'relayNode' });
      return 'movedOn';
    }

    if (deliveryStatus === 'DELIVERY_FAILED') {
      const context = failureContext ?? { reason: 'Unable to deliver message after negative remote response' };
      return baseService.retryOrFail(messageId, currentQueueKey, context, plugin);
    }

    if (deliveryStatus !== 'DELIVERY_SUCCESSFUL') {
      logger.warn({ module: 'incoming', deliveryStatus, parsedEvent }, 'unexpected delivery status');
      return 'rescheduled';
    }

    const storedMessage = await messageStore.getMessageById(messageId);
    if (!storedMessage) {
      logger.warn({ module: 'incoming', messageId }, 'message not found (already cleaned up?)');
      return 'orphaned';
    }

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

    // Persist webhook before dropping the device-message hash (durable notify).
    await baseService.emitDeliveryEvent(updatedMessage);
    metrics.recordMessageTerminal(
      'DELIVERY_SUCCESSFUL',
      storedMessage.retryCount ?? 0,
    );
    await moves.purge({ message: storedMessage, plugin });

    return 'removed';
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
    plugin: PushPlugin,
    meta?: IncomingHandleMeta,
  ): Promise<void> {
    const parsedEvent = plugin.incoming.handle(event, meta);
    if (!parsedEvent) {
      metrics.recordIngressUnhandled(plugin.id);
      return;
    }

    await processEvent(parsedEvent, STAGES.device.key(), plugin);
  }

  return { handle, processEvent };
}
