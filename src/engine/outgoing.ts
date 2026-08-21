/**
 * @fileoverview Outgoing command surface: enqueue, get-by-correlation, cancel, distribute,
 * send.
 *
 * Stage timeouts and retry requeueing are not here — they are rows in the stage table,
 * driven by `lifecycle/runner.ts` (ADR-008). What remains is the ready queue: admission,
 * the claim into `ns`, and the handoff to the plugin.
 */

import type { DeliveryConfig } from '../config/schema.js';
import { redisRepo } from '../lib/redis-repository/index.js';
import { redisKeys } from '../lib/redis-repository/keys.js';
import type {
  CancelMessageResult,
  CreateDeviceMessage,
  DeviceMessage,
} from '../lib/device-message/types.js';
import { logger } from '../log.js';
import type { MetricsRecorder } from '../metrics/index.js';
import {
  buildConcurrencyRateLimitKey,
  getPluginIdFromInitialQueueKey,
} from '../plugins/_shared/initial-queue-key.js';
import type {
  DeliveryPlugin,
  DistributeCtx,
} from '../plugins/plugin.interface.js';
import type { PluginRegistry } from '../plugins/registry.js';
import type { BaseService } from './base.js';
import {
  InvalidEnqueueError,
  UnknownPluginError,
  UnsupportedCommandTypeError,
} from './errors.js';
import { createStageMoves } from './lifecycle/moves.js';
import { QUEUE_NS_KEY, QUEUE_RETRY_KEY } from './lifecycle/stages.js';

/**
 * Outgoing command operations used by HTTP (and later by the engine).
 * Wired at the composition root (`main.ts`); unit tests inject a fake.
 */
export type OutgoingService = {
  /**
   * Enqueue a new message for delivery (plugin `initialQueueKey` + Redis).
   * @param create - Message creation parameters
   */
  enqueue(create: CreateDeviceMessage): Promise<DeviceMessage>;
  /**
   * Look up a message by correlation id.
   * @param correlationId - Caller-supplied correlation id
   */
  getByCorrelationId(correlationId: string): Promise<DeviceMessage | null>;
  /**
   * Cancel all messages for one correlation id.
   * @param correlationId - The correlation id to cancel
   */
  cancelOne(correlationId: string): Promise<CancelMessageResult>;
  /**
   * Cancel messages for many correlation ids.
   * @param correlationIds - Array of correlation ids to cancel
   */
  cancelMany(correlationIds: readonly string[]): Promise<CancelMessageResult[]>;
  /**
   * One distribute tick: admit + pick into NS + fire-and-forget `sendOne`.
   * Kicked at the end of every engine tick; tests may call it directly.
   */
  distributeToNetworkServers(): Promise<void>;
};

/** Dependencies for {@link createOutgoingService}. */
export type CreateOutgoingServiceOptions = {
  readonly registry: PluginRegistry;
  readonly delivery: DeliveryConfig;
  /** Shared retry/requeue helpers — constructed at the composition root with peers. */
  readonly baseService: BaseService;
  /**
   * When true (default), fire-and-forget {@link OutgoingService.distributeToNetworkServers}
   * after a successful enqueue. Set false in tests that need the message to remain
   * `QUEUED` (e.g. cancel smoke).
   */
  readonly kickDistributeOnEnqueue?: boolean;
  readonly metrics: MetricsRecorder;
};

/**
 * Redis-backed outgoing using plugin `initialQueueKey` for the initial queue.
 *
 * @param options - Registry, delivery, baseService, and optional enqueue-kick flag
 */
export function createOutgoingService(options: CreateOutgoingServiceOptions): OutgoingService {
  const { registry, delivery, baseService, kickDistributeOnEnqueue = true, metrics } = options;
  const moves = createStageMoves({ delivery });

  /**
   * Whether this queue may yield a message under the plugin's admission strategy.
   *
   * @param plugin - Owning delivery plugin (`admission`)
   * @param queueKey - Initial-queue Redis key being considered
   */
  async function _canAdmit(plugin: DeliveryPlugin, queueKey: string): Promise<boolean> {
    const { admission } = plugin;
    const ctx: DistributeCtx = { queueKey, pluginId: plugin.id };

    switch (admission.strategy) {
      case 'spacing': {
        const lockKey = redisKeys.lockForQueue(queueKey);
        const lockAcquired = await redisRepo.lockQueueForTimeMs(
          lockKey,
          admission.minIntervalMs,
        );
        return lockAcquired !== null;
      }
      case 'concurrency': {
        const rateLimitKey = buildConcurrencyRateLimitKey(queueKey);
        if (!rateLimitKey) return false;
        const tracked = await redisRepo.getConcurrencyRateLimitCount(rateLimitKey);
        if (tracked >= admission.maxInFlight) {
          const liveCount = await redisRepo.validateAndCleanConcurrencyRateLimit(rateLimitKey);
          if (liveCount >= admission.maxInFlight) return false;
        }
        return true;
      }
      case 'custom':
        return admission.canDistribute(ctx);
    }
  }

  /**
   * Post-pick admission hook (concurrency claim / custom `onClaim`).
   *
   * @param plugin - Owning delivery plugin (`admission`)
   * @param queueKey - Initial-queue Redis key the message was picked from
   * @param messageId - ULID of the claimed message
   */
  async function _onClaimAfterPick(plugin: DeliveryPlugin, queueKey: string, messageId: string): Promise<void> {
    const { admission } = plugin;

    switch (admission.strategy) {
      case 'spacing':
        return;
      case 'concurrency': {
        const rateLimitKey = buildConcurrencyRateLimitKey(queueKey);
        if (!rateLimitKey) return;
        await redisRepo.claimConcurrencyRateLimit(rateLimitKey, messageId);
        return;
      }
      case 'custom':
        if (admission.onClaim) {
          await admission.onClaim({ queueKey, pluginId: plugin.id, messageId });
        }
        return;
    }
  }

  /**
   * Send one message via the plugin; on success move NS → relay-node (PUSH) or awaiting-task (PULL).
   * On failure, {@link BaseService.retryOrFail} from the NS queue.
   *
   * @param plugin - Owning delivery plugin (`outgoing.sendOne` + tuning)
   * @param message - The message to send (already in NS queue)
   */
  async function _sendOneToNetworkServer(plugin: DeliveryPlugin, message: DeviceMessage): Promise<void> {
    let deliveryQueueId: string;
    const startedAt = performance.now();
    const slowThresholdMs = plugin.tuning.nsInFlightTimeoutMs;

    try {
      deliveryQueueId = await plugin.outgoing.sendOne(message);
    }
    catch (err) {
      const elapsedMs = Math.round(performance.now() - startedAt);
      if (elapsedMs > slowThresholdMs) {
        logger.warn({
          module: 'outgoing',
          err,
          elapsedMs,
          externalReference: message.device.externalReference,
          correlationId: message.correlationId,
          messageId: message.id,
        }, 'sendOne slow then threw');
      }
      await baseService.retryOrFail(
        message.id,
        QUEUE_NS_KEY,
        plugin.outgoing.parseError(err),
        plugin,
      );
      return;
    }

    const elapsedMs = Math.round(performance.now() - startedAt);
    if (elapsedMs > slowThresholdMs) {
      logger.warn({
        module: 'outgoing',
        elapsedMs,
        externalReference: message.device.externalReference,
        correlationId: message.correlationId,
        messageId: message.id,
      }, 'sendOne slow; resolution cycle may have already scheduled a retry');
    }

    if (!deliveryQueueId) {
      await baseService.retryOrFail(
        message.id,
        QUEUE_NS_KEY,
        {
          reason: 'Plugin returned an empty deliveryQueueId after sendOne',
          skipRetry: true,
        },
        plugin,
      );
      return;
    }

    await moves.advance({
      messageId: message.id,
      plugin,
      from: 'ns',
      deliveryQueueId,
      retryCount: message.retryCount ?? 0,
    });
  }

  /**
   * Process all initial queues that have work: admit, pick into NS, emit first-send event,
   * then fire-and-forget plugin `sendOne` (tick completes at handoff).
   *
   * Distribution strategy is plugin-declared (ADR-006): spacing lock, concurrency cap,
   * or custom hooks — never inferred from the human `kind` segment of the queue key.
   */
  async function distributeToNetworkServers(): Promise<void> {
    const activeQueues = await redisRepo.fetchQueuesWithMessages();

    await Promise.all(activeQueues.map(async queueKey => {
      const pluginId = getPluginIdFromInitialQueueKey(queueKey);
      if (!pluginId) return;

      const plugin = registry.get(pluginId);
      if (!plugin || plugin.deliveryPattern === 'NONE') return;

      const admitted = await _canAdmit(plugin, queueKey);
      if (!admitted) return;

      const messageToSend = await moves.pickIntoNs(queueKey, plugin);
      if (!messageToSend) return;

      await _onClaimAfterPick(plugin, queueKey, messageToSend.id);

      // If not a retry, notify the adopter that the message is getting handled.
      // (The message status is already 'SENT_TO_NS'.) Await Redis enqueue only.
      if (!messageToSend.retryCount) {
        await baseService.emitDeliveryEvent(messageToSend);
      }

      // Fire-and-forget: distribute considers the handoff done once picked.
      void _sendOneToNetworkServer(plugin, messageToSend).catch(err => {
        logger.error({ module: 'outgoing', err }, 'sendOne failed');
      });
    }));
  }

  /**
   * Attempt to cancel a single device message from its current queue.
   *
   * Uses ZREM as an atomic claim: if ZREM returns 1 we own the message and
   * proceed with full cleanup. If it returns 0 the message has already been
   * picked up by the distributor or reaper, so we leave it alone.
   *
   * Only `QUEUED` / `TO_RETRY` are cancellable — anything further along has
   * already been handed off to the network server. `QUEUED` resolves the
   * initial queue through the registered plugin (`initialQueueKey`).
   *
   * @param message - The device message to cancel
   * @returns true if the message was successfully removed, false otherwise
   */
  async function _cancelOneMessage(message: DeviceMessage): Promise<boolean> {
    const { deliveryStatus } = message;

    if (deliveryStatus !== 'QUEUED' && deliveryStatus !== 'TO_RETRY') {
      return false;
    }

    const plugin = registry.get(message.pluginId);
    if (!plugin || plugin.deliveryPattern === 'NONE') return false;

    const queueKey = deliveryStatus === 'TO_RETRY'
      ? QUEUE_RETRY_KEY
      : plugin.initialQueueKey({
        networkId: message.networkId,
        device: message.device,
      });

    const removed = await redisRepo.removeMessageFromQueue(queueKey, message.id);
    if (removed === 0) return false;

    await moves.purge({ message, plugin });
    metrics.recordMessageTerminal('CANCELLED', message.retryCount ?? 0);
    return true;
  }

  /**
   * Cancel a single device message by its correlation id.
   *
   * Only messages in QUEUED or TO_RETRY state can be cancelled — anything
   * further along the pipeline has already been handed off to the network server.
   * Uses atomic ZREM as a "claim" to prevent race conditions with the distributor
   * and the reaper cycle.
   *
   * @param correlationId - The correlation id to cancel
   * @returns Result indicating whether the message was cancelled, not cancellable, or not found
   */
  async function _cancelOneByCorrelationId(
    correlationId: string,
  ): Promise<CancelMessageResult> {
    const messages = await redisRepo.getAllMessagesForCorrelationId(correlationId);

    if (messages.length === 0) {
      return { correlationId, result: 'NOT_FOUND' };
    }

    const outcomes = await Promise.all(messages.map(message => _cancelOneMessage(message)));
    const allCancelled = outcomes.every(Boolean);
    const result = allCancelled ? 'CANCELLED' : 'NOT_CANCELLABLE';

    return { correlationId, result };
  }

  return {
    async enqueue(create: CreateDeviceMessage): Promise<DeviceMessage> {
      const plugin = registry.get(create.pluginId);
      if (!plugin) throw new UnknownPluginError(create.pluginId);
      if (plugin.deliveryPattern === 'NONE') {
        throw new UnsupportedCommandTypeError(create.pluginId, create.commandType);
      }
      if (!plugin.supportedCommandTypes.includes(create.commandType)) {
        throw new UnsupportedCommandTypeError(create.pluginId, create.commandType);
      }
      const enqueueIssue = plugin.validateEnqueue?.(create);
      if (enqueueIssue !== undefined) {
        throw new InvalidEnqueueError(create.pluginId, enqueueIssue);
      }

      const queueKey = plugin.initialQueueKey({
        networkId: create.networkId,
        device: create.device,
      });

      const message = await redisRepo.enqueueDeviceMessage(create, queueKey);

      // Fire-and-forget: try a distribute tick after enqueue.
      if (kickDistributeOnEnqueue) {
        void distributeToNetworkServers().catch(err => {
          logger.error({ module: 'outgoing', err }, 'distribute after enqueue failed');
        });
      }

      return message;
    },

    getByCorrelationId(correlationId: string): Promise<DeviceMessage | null> {
      return redisRepo.getMessageFromCorrelationId(correlationId);
    },

    cancelOne(correlationId: string): Promise<CancelMessageResult> {
      return _cancelOneByCorrelationId(correlationId);
    },

    /**
     * Cancel multiple device messages by their correlation ids.
     *
     * @performance Current approach: O(N) Redis round-trips (~4 per ID). Acceptable
     * for typical batch sizes (<50). For large batches (hundreds), the lookup phase
     * can be batched: collect all index keys (base + phases A/B/C per ID) into a
     * single MGET, then pipeline the HGETALLs. This cuts lookup round-trips from
     * 2N to 2. The per-message cancel loop (ZREM claim + messageFullCleanup) should
     * stay sequential to preserve the atomic claim semantics.
     *
     * @param correlationIds - Array of correlation ids to cancel
     * @returns Array of results, one per id
     */
    cancelMany(correlationIds: readonly string[]): Promise<CancelMessageResult[]> {
      return Promise.all(correlationIds.map(id => _cancelOneByCorrelationId(id)));
    },

    distributeToNetworkServers,
  };
}
