/**
 * @fileoverview Shared engine helpers for delivery outcomes and retry.
 *
 * Adopter notification goes through {@link emitDeliveryEvent} (stub until Phase 3
 * lands the outbound webhook — ADR-003).
 *
 * Concurrency admission: the rate-limit key is stored on the message hash at claim
 * (`claimConcurrencyRateLimit`). `messageFullCleanup` / `fromAnyToRetry` SREM it.
 */

import { isNotNil } from 'ramda';
import type { DeliveryConfig } from '../config/schema.js';
import { moveQueue, QUEUE_RETRY_KEY } from '../lib/queue-moving.js';
import { redisRepo } from '../lib/redis-repository/index.js';
import { calculateBackoffDelay } from '../lib/retry-helpers.js';
import { omitInternalFields } from '../lib/device-message/omit-internal-fields.js';
import type {
  DeviceMessage,
  DeviceMessageDeliveryStatus,
  DeviceMessageDevice,
  FailureContext,
  FailureReason,
} from '../lib/device-message/types.js';
import type { PluginRegistry } from '../plugins/registry.js';

/**
 * Notify the adopter of a delivery event (first SENT_TO_NS, terminal, unsolicited, …).
 *
 * Stub until Phase 3 lands the outbound webhook (ADR-003 §6 / `resultWebhook.url`).
 * Engine call sites must use this seam — do not reintroduce in-process subscribers.
 *
 * @param message - The message (or partial) to broadcast
 */
export function emitDeliveryEvent(message: Partial<DeviceMessage>): void {
  const payload = omitInternalFields(message);
  // Temporary until Phase 3 webhook — see delivery outcomes in the process log.
  console.info('[emitDeliveryEvent]', {
    id: payload.id,
    correlationId: payload.correlationId,
    commandType: payload.commandType,
    deliveryStatus: payload.deliveryStatus,
    response: payload.response,
    device: payload.device?.externalReference,
    unsolicited: payload.unsolicited,
  });
}

/** Shared retry / requeue operations used by peers. */
export type BaseService = {
  retryOrFail(
    messageId: string,
    currentQueueKey: string,
    failureContext: FailureContext,
  ): Promise<void>;
  requeueMessage(messageId: string): Promise<void>;
};

/** Dependencies for {@link createBaseService}. */
export type CreateBaseServiceOptions = {
  readonly registry: PluginRegistry;
  readonly delivery: DeliveryConfig;
};

/**
 * Factory for shared delivery-outcome helpers (no runtime import).
 *
 * @param options - Registry (requeue → `initialQueueKey`) and delivery knobs (retries / backoff)
 */
export function createBaseService(options: CreateBaseServiceOptions): BaseService {
  const { registry, delivery } = options;

  /**
   * Handle a failed delivery attempt by either scheduling a retry or failing permanently.
   *
   * Decision logic:
   * - If skipRetry is true: fail immediately (unrecoverable error)
   * - If retryCount >= maxRetries: clean up and emit failure
   * - Otherwise: schedule retry with exponential backoff
   *
   * @param messageId - ULID of the message
   * @param currentQueueKey - The queue where the message currently resides
   * @param failureContext - Details about why the failure occurred
   */
  async function retryOrFail(
    messageId: string,
    currentQueueKey: string,
    failureContext: FailureContext,
  ): Promise<void> {
    const message = await redisRepo.getMessageById(messageId);

    if (!message) {
      await redisRepo.removeMessageFromQueue(currentQueueKey, messageId);
      return;
    }

    const currentRetryCount = message.retryCount ?? 0;
    const isFinalFailure =
      failureContext.skipRetry || currentRetryCount >= delivery.maxRetries;
    const newFailureHistory: FailureReason[] = [
      {
        timestamp: (new Date()).toISOString(),
        status: message.deliveryStatus,
        reason: failureContext.reason,
        ...(isNotNil(failureContext.errorCode) && { errorCode: failureContext.errorCode }),
        ...(failureContext.details && { details: failureContext.details }),
        isFinal: isFinalFailure,
      },
      ...(message.failureHistory ?? []),
    ];

    if (isFinalFailure) {
      await redisRepo.messageFullCleanup(message);
      emitDeliveryEvent({
        ...message,
        failureHistory: newFailureHistory,
        deliveryStatus: 'DELIVERY_FAILED',
      });
      return;
    }

    const backoffMs = calculateBackoffDelay(currentRetryCount, delivery);
    const newRetryCount = currentRetryCount + 1;
    const nextRetryAt = Date.now() + backoffMs;

    const updateProps = {
      retryCount: newRetryCount,
      deliveryStatus: 'TO_RETRY' as DeviceMessageDeliveryStatus,
      failureHistory: newFailureHistory,
    };

    await moveQueue.fromAnyToRetry(
      messageId,
      currentQueueKey,
      nextRetryAt,
      updateProps,
    );
  }

  /**
   * Move a message from the retry queue back to its plugin bottleneck queue.
   * Called when the backoff period has elapsed and the message is ready for another attempt.
   *
   * Uses a partial HMGET (not full hash deserialize) — only topology fields for
   * `initialQueueKey`, plus priority for the Redis score.
   *
   * @param messageId - ULID of the message to requeue
   */
  async function requeueMessage(messageId: string): Promise<void> {
    const [ priorityStr, deviceStr, networkIdStr, pluginId ] =
      await redisRepo.getMessageRawPropsById(messageId, [
        'priority',
        'device',
        'networkId',
        'pluginId',
      ]);

    if (!priorityStr || !deviceStr || !pluginId) {
      console.warn(`[requeueMessage] Orphaned retry id ${ messageId }. Removing.`);
      await redisRepo.removeMessageFromQueue(QUEUE_RETRY_KEY, messageId);
      return;
    }

    const plugin = registry.get(pluginId);
    if (!plugin) {
      await redisRepo.removeMessageFromQueue(QUEUE_RETRY_KEY, messageId);
      return;
    }

    const priority = parseInt(priorityStr, 10);
    let device: DeviceMessageDevice;
    try {
      device = JSON.parse(deviceStr) as DeviceMessageDevice;
    }
    catch {
      console.warn(`[requeueMessage] Malformed device JSON for retry id ${ messageId }. Removing.`);
      await redisRepo.removeMessageFromQueue(QUEUE_RETRY_KEY, messageId);
      return;
    }

    // `networkId` is omitted from the hash when null (see serializeCreateDeviceMessage).
    const networkId = networkIdStr !== null ? parseInt(networkIdStr, 10) : null;

    const destinationQueue = plugin.initialQueueKey({ networkId, device });
    await redisRepo.requeueMessage(
      messageId,
      QUEUE_RETRY_KEY,
      destinationQueue,
      priority,
    );
  }

  return {
    retryOrFail,
    requeueMessage,
  };
}
