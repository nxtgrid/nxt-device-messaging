/**
 * @fileoverview Shared engine helpers for delivery outcomes and retry.
 *
 * Adopter notification goes through {@link BaseService.emitDeliveryEvent}, which
 * thin-forwards to the outbound webhook messenger when configured (ADR-003 §6).
 *
 * Concurrency admission: the rate-limit key is stored on the message hash at claim
 * (`claimConcurrencyRateLimit`). `messageFullCleanup` / `fromAnyToRetry` SREM it.
 */

import { isNotNil } from 'ramda';
import type { DeliveryConfig } from '../config/schema.js';
import { moveQueue, QUEUE_RETRY_KEY } from '../lib/queue-moving.js';
import { redisRepo } from '../lib/redis-repository/index.js';
import { calculateBackoffDelay } from '../lib/retry-helpers.js';
import type {
  DeviceMessage,
  DeviceMessageDeliveryStatus,
  DeviceMessageDevice,
  FailureContext,
  FailureReason,
} from '../lib/device-message/types.js';
import type { PluginRegistry } from '../plugins/registry.js';
import type { WebhookService } from './webhook/service.js';

/** Shared retry / requeue / adopter-notify operations used by peers. */
export type BaseService = {
  retryOrFail(
    messageId: string,
    currentQueueKey: string,
    failureContext: FailureContext,
  ): Promise<void>;
  requeueMessage(messageId: string): Promise<void>;
  /**
   * Notify the adopter of a delivery event (first SENT_TO_NS, terminal, unsolicited, …).
   * Awaits Redis persistence of the webhook event when a webhook is wired; otherwise no-op.
   * Does not await HTTP delivery. Callers must await this before cleaning up the source message.
   */
  emitDeliveryEvent(message: Partial<DeviceMessage>): Promise<void>;
};

/** Dependencies for {@link createBaseService}. */
export type CreateBaseServiceOptions = {
  readonly registry: PluginRegistry;
  readonly delivery: DeliveryConfig;
  /**
   * Outbound event webhook. When omitted (no `eventWebhook` in config), emits are no-ops.
   */
  readonly webhook?: Pick<WebhookService, 'storeAndEmit'>;
};

/**
 * Factory for shared delivery-outcome helpers (no runtime import).
 *
 * @param options - Registry, delivery knobs, optional webhook messenger
 */
export function createBaseService(options: CreateBaseServiceOptions): BaseService {
  const { registry, delivery, webhook } = options;

  async function emitDeliveryEvent(message: Partial<DeviceMessage>): Promise<void> {
    if (!webhook) return;
    await webhook.storeAndEmit(message);
  }

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
      // Persist webhook before dropping the device-message hash (durable notify).
      await emitDeliveryEvent({
        ...message,
        failureHistory: newFailureHistory,
        deliveryStatus: 'DELIVERY_FAILED',
      });
      await redisRepo.messageFullCleanup(message);
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
    emitDeliveryEvent,
  };
}
