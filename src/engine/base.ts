/**
 * @fileoverview Shared engine helpers for delivery outcomes and retry.
 *
 * Ported from frozen `device-messages.service.ts` (baseline db5c2ac), Nest-stripped.
 *
 * In-process `subscribe` / `publish` are **not** ported — ADR-003 replaces them with an
 * outbound result webhook. Call sites use {@link emitDeliveryEvent} (stub until Phase 3).
 */

import { isNotNil } from 'ramda';
import { moveQueue, QUEUE_RETRY_KEY } from '../lib/queue-moving.js';
import { redisRepo } from '../lib/redis-repository/index.js';
import { calculateBackoffDelay } from '../lib/retry-helpers.js';
import type {
  DeviceMessage,
  DeviceMessageDeliveryStatus,
  DeviceMessageDevice,
  FailureContext,
  FailureReason,
} from '../lib/types.js';
import { config, pluginRegistry } from '../runtime.js';


/**
 * Notify the adopter of a delivery event (first SENT_TO_NS, terminal, unsolicited, …).
 *
 * Stub until Phase 3 lands the outbound webhook (ADR-003 §6 / `resultWebhook.url`).
 * Engine call sites must use this seam — do not reintroduce in-process subscribers.
 */
export function emitDeliveryEvent(_message: Partial<DeviceMessage>): void {
  // no-op
}

/**
 * Handle a failed delivery attempt by either scheduling a retry or failing permanently.
 *
 * Decision logic:
 * - If skipRetry is true: fail immediately (unrecoverable error)
 * - If retry_count >= maxRetries: clean up and emit failure
 * - Otherwise: schedule retry with exponential backoff
 *
 * @param messageId - ULID of the message
 * @param currentQueueKey - The queue where the message currently resides
 * @param failureContext - Details about why the failure occurred
 * @param options - Optional D2 seams (e.g. concurrency track key when admission is wired)
 */
export async function retryOrFail(
  messageId: string,
  currentQueueKey: string,
  failureContext: FailureContext,
  options?: {
    concurrencyRateLimitKey?: string;
  },
): Promise<void> {
  const message = await redisRepo.getMessageById(messageId);

  if (!message) {
    await redisRepo.removeMessageFromQueue(currentQueueKey, messageId);
    return;
  }

  const currentRetryCount = message.retry_count ?? 0;
  const isFinalFailure =
    failureContext.skipRetry || currentRetryCount >= config.delivery.maxRetries;
  const newFailureHistory: FailureReason[] = [
    {
      timestamp: (new Date()).toISOString(),
      status: message.delivery_status,
      reason: failureContext.reason,
      ...(isNotNil(failureContext.errorCode) && { errorCode: failureContext.errorCode }),
      ...(failureContext.details && { details: failureContext.details }),
      isFinal: isFinalFailure,
    },
    ...(message.failure_history ?? []),
  ];

  if (isFinalFailure) {
    await redisRepo.messageFullCleanup(message, {
      concurrencyRateLimitKey: options?.concurrencyRateLimitKey,
    });
    emitDeliveryEvent({
      ...message,
      failure_history: newFailureHistory,
      delivery_status: 'DELIVERY_FAILED',
    });
    return;
  }

  const backoffMs = calculateBackoffDelay(currentRetryCount, config.delivery);
  const newRetryCount = currentRetryCount + 1;
  const nextRetryAt = Date.now() + backoffMs;

  const updateProps = {
    retry_count: newRetryCount,
    delivery_status: 'TO_RETRY' as DeviceMessageDeliveryStatus,
    failure_history: newFailureHistory,
  };

  await moveQueue.fromAnyToRetry(
    messageId,
    currentQueueKey,
    nextRetryAt,
    updateProps,
    { concurrencyRateLimitKey: options?.concurrencyRateLimitKey },
  );
}

/**
 * Move a message from the retry queue back to its plugin bottleneck queue.
 * Called when the backoff period has elapsed and the message is ready for another attempt.
 *
 * Uses a partial HMGET (not full hash deserialize) — only topology fields for
 * `bottleneckKey`, plus priority for the Redis score.
 *
 * @param messageId - ULID of the message to requeue
 */
export async function requeueMessage(messageId: string): Promise<void> {
  const [ priorityStr, deviceStr, networkIdStr, pluginId ] =
    await redisRepo.getMessageRawPropsById(messageId, [
      'priority',
      'device',
      'network_id',
      'plugin_id',
    ]);

  if (!priorityStr || !deviceStr || !pluginId) {
    console.warn(`[DEVICE MESSAGING] Orphaned retry id ${ messageId }. Removing.`);
    await redisRepo.removeMessageFromQueue(QUEUE_RETRY_KEY, messageId);
    return;
  }

  const plugin = pluginRegistry.get(pluginId);
  if (!plugin) {
    console.warn(
      `[DEVICE MESSAGING] No plugin registered for ${ pluginId } (message ${ messageId }). Removing from retry.`,
    );
    await redisRepo.removeMessageFromQueue(QUEUE_RETRY_KEY, messageId);
    return;
  }

  const priority = parseInt(priorityStr, 10);
  const device = JSON.parse(deviceStr) as DeviceMessageDevice;
  // `network_id` is omitted from the hash when null (see serializeCreateDeviceMessage).
  const network_id = networkIdStr !== null ? parseInt(networkIdStr, 10) : null;

  const destinationQueue = plugin.bottleneckKey({ network_id, device });
  await redisRepo.requeueMessage(
    messageId,
    QUEUE_RETRY_KEY,
    destinationQueue,
    priority,
  );
}
