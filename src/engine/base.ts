/**
 * @fileoverview Shared engine helpers for delivery outcomes and retry.
 *
 * Adopter notification goes through {@link emitDeliveryEvent} (stub until Phase 3
 * lands the outbound webhook — ADR-003).
 *
 * Concurrency admission release is owned here: {@link BaseService.cleanupMessage} and
 * {@link BaseService.retryOrFail} derive the rate-limit key from the registry so
 * callers never thread it (legacy inferred it inside cleanup).
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
import { buildConcurrencyRateLimitKey } from '../plugins/_shared/initial-queue-key.js';
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
  // Temporary until Phase 3 webhook — see delivery outcomes in the process log.
  console.info('[emitDeliveryEvent]', {
    id: message.id,
    correlationId: message.correlationId,
    commandType: message.commandType,
    deliveryStatus: message.deliveryStatus,
    response: message.response,
    device: message.device?.externalReference,
    unsolicited: message.unsolicited,
  });
}

/** Shared retry / requeue / cleanup operations used by peers. */
export type BaseService = {
  /**
   * Full message scrub including concurrency admission slot when applicable.
   * Prefer this over calling `redisRepo.messageFullCleanup` from engine peers.
   */
  cleanupMessage(message: DeviceMessage): Promise<void>;
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

  function _concurrencyRateLimitKeyFor(message: DeviceMessage): string | undefined {
    const plugin = registry.get(message.pluginId);
    if (!plugin || plugin.admission.strategy !== 'concurrency') return undefined;
    return buildConcurrencyRateLimitKey(
      plugin.initialQueueKey({
        networkId: message.networkId,
        device: message.device,
      }),
    );
  }

  /**
   * Delete message hash, stage membership, indexes, and concurrency track slot.
   *
   * @param message - Message to remove
   */
  async function cleanupMessage(message: DeviceMessage): Promise<void> {
    await redisRepo.messageFullCleanup(message, {
      concurrencyRateLimitKey: _concurrencyRateLimitKeyFor(message),
    });
  }

  /**
   * Handle a failed delivery attempt by either scheduling a retry or failing permanently.
   *
   * Decision logic:
   * - If skipRetry is true: fail immediately (unrecoverable error)
   * - If retryCount >= maxRetries: clean up and emit failure
   * - Otherwise: schedule retry with exponential backoff
   *
   * Releases the concurrency admission slot on both retry and final failure when
   * the plugin uses that strategy.
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
      await cleanupMessage(message);
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
      { concurrencyRateLimitKey: _concurrencyRateLimitKeyFor(message) },
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
    cleanupMessage,
    retryOrFail,
    requeueMessage,
  };
}
