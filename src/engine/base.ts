/**
 * @fileoverview Shared engine helpers for delivery outcomes and retry.
 *
 * Adopter notification goes through {@link BaseService.emitDeliveryEvent}, which
 * thin-forwards to the outbound webhook messenger when configured (ADR-003 §6).
 *
 * Concurrency admission: the rate-limit key is stored on the message hash at claim
 * (`claimConcurrencyRateLimit`). `messageFullCleanup` / `enterRetry` SREM it.
 */

import { isNotNil } from 'ramda';
import type { DeliveryConfig } from '../config/schema.js';
import { redisRepo } from '../lib/redis-repository/index.js';
import type {
  DeviceMessage,
  FailureContext,
  FailureReason,
} from '../lib/device-message/types.js';
import type { MetricsRecorder } from '../metrics/index.js';
import type { DeliveryPlugin } from '../plugins/plugin.interface.js';
import { createStageMoves } from './lifecycle/moves.js';
import type { StageOutcome } from './lifecycle/types.js';
import type { WebhookService } from './webhook/service.js';

/** Shared retry / adopter-notify operations used by peers. */
export type BaseService = {
  /**
   * Retry a failed attempt, or fail it permanently when retries are exhausted or the
   * failure is unrecoverable.
   *
   * @param messageId - ULID of the message
   * @param currentQueueKey - Queue the message currently sits in
   * @param failureContext - Why the attempt failed
   * @param plugin - Owning delivery plugin; every caller has already resolved one
   * @returns `removed` when it failed permanently, `movedOn` when it entered retry,
   * `orphaned` when the hash was already gone
   */
  retryOrFail(
    messageId: string,
    currentQueueKey: string,
    failureContext: FailureContext,
    plugin: DeliveryPlugin,
  ): Promise<StageOutcome>;
  /**
   * Notify the adopter of a delivery event (first SENT_TO_NS, terminal, unsolicited, …).
   * Awaits Redis persistence of the webhook event when a webhook is wired; otherwise no-op.
   * Does not await HTTP delivery. Callers must await this before cleaning up the source message.
   */
  emitDeliveryEvent(message: Partial<DeviceMessage>): Promise<void>;
};

/** Dependencies for {@link createBaseService}. */
export type CreateBaseServiceOptions = {
  readonly delivery: DeliveryConfig;
  /**
   * Outbound event webhook. When omitted (no `eventWebhook` in config), emits are no-ops.
   */
  readonly webhook?: Pick<WebhookService, 'storeAndEmit'>;
  readonly metrics: MetricsRecorder;
};

/**
 * Factory for shared delivery-outcome helpers (no runtime import).
 *
 * @param options - Delivery knobs, optional webhook messenger, metrics
 */
export function createBaseService(options: CreateBaseServiceOptions): BaseService {
  const { delivery, webhook, metrics } = options;
  const moves = createStageMoves({ delivery, metrics });

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
    plugin: DeliveryPlugin,
  ): Promise<StageOutcome> {
    const message = await redisRepo.getMessageById(messageId);

    if (!message) {
      await redisRepo.removeMessageFromQueue(currentQueueKey, messageId);
      return 'orphaned';
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
      metrics.recordMessageTerminal('DELIVERY_FAILED', currentRetryCount);
      await moves.purge({ message, plugin });
      return 'removed';
    }

    await moves.enterRetry({
      messageId,
      fromKey: currentQueueKey,
      currentRetryCount,
      failureHistory: newFailureHistory,
      plugin,
    });

    return 'movedOn';
  }

  return {
    retryOrFail,
    emitDeliveryEvent,
  };
}
