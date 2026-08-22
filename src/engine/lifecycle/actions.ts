/**
 * @fileoverview What to do with a message whose wait has run out — one action per stage.
 *
 * One place to read the whole failure and resolution story of a message, and the reason
 * the table is total: a row without an action does not compile.
 *
 * An action does domain work and reports a {@link StageOutcome}. It never writes a score
 * and never removes a member — the runner does both, once, for every stage (ADR-008 §5).
 */

import type { DeviceMessage } from '../../lib/device-message/types.js';
import { logger } from '../../log.js';
import type { MetricsRecorder } from '../../metrics/index.js';
import type { DeliveryPlugin } from '../../plugins/plugin.interface.js';
import type { BaseService } from '../base.js';
import type { IncomingService } from '../incoming.js';
import type { InFlightSends } from '../in-flight-sends.js';
import type { StageMoves } from './moves.js';
import { PULL_MAX_MESSAGE_AGE_MS, QUEUE_NS_KEY, QUEUE_RETRY_KEY } from './stages.js';
import type { StageActions } from './types.js';

/** Why a message failed, per stage. Prose the adopter sees on the webhook. */
const TIMEOUT_REASONS = {
  ns: 'Timed out waiting for Network Server to accept message',
  relayNode: 'Timed out waiting for relay node to transmit message to device',
  device: 'Timed out waiting for device response after transmission',
  awaitingTask: 'Timed out waiting for remote task completion',
} as const;

/** Dependencies for {@link createStageActions}. */
export type CreateStageActionsOptions = {
  readonly baseService: BaseService;
  readonly incomingService: Pick<IncomingService, 'processEvent'>;
  readonly moves: StageMoves;
  /** Sends still held by this process — the `ns` row's stay of execution (ADR-008 §8). */
  readonly inFlightSends: InFlightSends;
  readonly metrics: MetricsRecorder;
};

/**
 * Build the stage actions.
 *
 * @param options - Engine peers the actions delegate to
 */
export function createStageActions(options: CreateStageActionsOptions): StageActions {
  const { baseService, incomingService, moves, inFlightSends, metrics } = options;

  /**
   * Give up on a PULL message that outlived the age cap.
   *
   * Permanent by design: a task the vendor never completed in 48 hours will not complete,
   * and re-sending it would be a duplicate physical action two days late.
   *
   * @param message - The expired message, still present in Redis
   * @param plugin - Its owning plugin
   */
  async function _failPermanently(
    message: DeviceMessage,
    plugin: DeliveryPlugin,
  ): Promise<void> {
    const failed: DeviceMessage = {
      ...message,
      deliveryStatus: 'DELIVERY_FAILED',
      failureHistory: [
        {
          timestamp: (new Date()).toISOString(),
          status: 'DELIVERED_TO_NS',
          reason: TIMEOUT_REASONS.awaitingTask,
          isFinal: true,
        },
        ...(message.failureHistory ?? []),
      ],
    };

    // Persist the webhook before dropping the hash (durable notify).
    await baseService.emitDeliveryEvent(failed);
    metrics.recordMessageTerminal('DELIVERY_FAILED', message.retryCount ?? 0);
    await moves.purge({ message: failed, plugin });
  }

  return {
    /**
     * The deadline is for a send that vanished, not for one we are still holding. While
     * this process awaits the promise it knows the send is alive, so the wait is extended
     * instead — which is what makes A3's duplicate command unreachable (ADR-008 §8).
     */
    ns({ message, plugin }) {
      if (inFlightSends.has(message.id)) return Promise.resolve('rescheduled');

      return baseService.retryOrFail(
        message.id,
        QUEUE_NS_KEY,
        { reason: TIMEOUT_REASONS.ns },
        plugin,
      );
    },

    /**
     * A relay node that still holds the command has not failed — it is slow. Plugins that
     * can answer "do you still have it?" get to say so, and the wait is extended.
     */
    async relayNode({ message, plugin, queueKey }) {
      const getRemoteStatus = plugin.deliveryPattern === 'PUSH'
        ? plugin.outgoing.getRemoteStatus
        : undefined;

      if (getRemoteStatus) {
        try {
          const { deliveryStatus } = await getRemoteStatus(message);
          if (deliveryStatus !== 'DELIVERY_FAILED') return 'rescheduled';
        }
        catch (err) {
          logger.error(
            { module: 'lifecycle', err, messageId: message.id },
            'getRemoteStatus failed',
          );
        }
      }

      return baseService.retryOrFail(
        message.id,
        queueKey,
        { reason: TIMEOUT_REASONS.relayNode },
        plugin,
      );
    },

    device: ({ message, plugin, queueKey }) => baseService.retryOrFail(
      message.id,
      queueKey,
      { reason: TIMEOUT_REASONS.device },
      plugin,
    ),

    /**
     * The one stage whose due time is an appointment rather than a deadline: ask the
     * vendor how the task is doing, and either resolve the message or wait again on the
     * poll ladder.
     */
    async awaitingTask({ message, plugin, queueKey, messageAgeMs }) {
      if (messageAgeMs >= PULL_MAX_MESSAGE_AGE_MS) {
        await _failPermanently(message, plugin);
        return 'removed';
      }

      const fetchStatus = plugin.deliveryPattern === 'PULL'
        ? plugin.incoming.fetchStatus
        : undefined;

      if (!fetchStatus) {
        logger.warn(
          { module: 'lifecycle', messageId: message.id, pluginId: plugin.id },
          'awaiting-task member owned by a plugin that cannot poll',
        );
        return 'rescheduled';
      }

      // Cleared by `enterRetry`; the message is on its way out of this stage anyway.
      if (!message.deliveryQueueId) return 'rescheduled';

      const parsedEvent = await fetchStatus(message);
      if (!parsedEvent) return 'rescheduled';

      return incomingService.processEvent(parsedEvent, queueKey, plugin);
    },

    /**
     * Backoff elapsed: back to the plugin's ready queue at its original priority, where
     * admission decides when it is sent again.
     */
    async retry({ message, plugin }) {
      const destination = plugin.initialQueueKey({
        networkId: message.networkId,
        device: message.device,
      });

      const moved = await moves.requeue({
        messageId: message.id,
        fromKey: QUEUE_RETRY_KEY,
        toKey: destination,
        priority: message.priority,
      });

      return moved ? 'movedOn' : 'orphaned';
    },
  };
}
