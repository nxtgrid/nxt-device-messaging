/**
 * @fileoverview Outgoing command surface: enqueue, get-by-correlation, cancel, distribute,
 * send.
 *
 * Stage timeouts and retry requeueing are not here — they are rows in the stage table,
 * driven by `lifecycle/runner.ts` (ADR-008). What remains is the ready queue: admission,
 * the claim into `ns`, and the handoff to the plugin.
 */

import type { DeliveryConfig } from '../config/schema.js';
import type {
  CancelMessageResult,
  CreateDeviceMessage,
  DeviceMessage,
} from '../lib/device-message/types.js';
import type { AdmissionStore } from '../lib/redis-repository/admission-store.js';
import { redisKeys } from '../lib/redis-repository/keys.js';
import type { MessageStore } from '../lib/redis-repository/message-store.js';
import { logger } from '../log.js';
import type { MetricsRecorder } from '../metrics/index.js';
import {
  buildConcurrencyRateLimitKey,
  getPluginIdFromInitialQueueKey,
} from '../plugins/_shared/initial-queue-key.js';
import type { DeliveryPlugin } from '../plugins/plugin.interface.js';
import type { PluginRegistry } from '../plugins/registry.js';
import type { BaseService } from './base.js';
import {
  InvalidEnqueueError,
  UnknownPluginError,
  UnsupportedCommandTypeError,
} from './errors.js';
import type { InFlightSends } from './in-flight-sends.js';
import type { StageMoves } from './lifecycle/moves.js';
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
  /**
   * Wait until in-flight sends settle, or `budgetMs` elapses (ADR-008 §8).
   *
   * Shutdown: stop the timers so nothing new is picked, drain here, *then* close Redis —
   * a send landing mid-drain still has to write its external id and move stage.
   *
   * @param budgetMs - How long to wait before abandoning the rest
   * @returns The number still outstanding when the budget ran out
   */
  drainInFlightSends(budgetMs: number): Promise<number>;
  /**
   * Stop kicking distribute after enqueue. Enqueue still stores; the next process
   * tick picks `QUEUED` work up. Shutdown calls this before drain so a request that
   * lands after the in-flight set goes quiet cannot start a send on this process.
   */
  stopEnqueueKick(): void;
};

/** Dependencies for {@link createOutgoingService}. */
export type CreateOutgoingServiceOptions = {
  readonly registry: PluginRegistry;
  readonly delivery: DeliveryConfig;
  /** Shared retry/requeue helpers — constructed at the composition root with peers. */
  readonly baseService: BaseService;
  /**
   * Sends this process is still awaiting. Shared with the `ns` stage action, which must not
   * time out a send we are still holding (ADR-008 §8).
   */
  readonly inFlightSends: InFlightSends;
  /**
   * When true, fire-and-forget {@link OutgoingService.distributeToNetworkServers}
   * after a successful enqueue. Production passes `config.engine.enabled` so a
   * service with the engine off stores commands but does not distribute them —
   * no tick would follow up (ADR-008 §13 / B3). Shutdown clears the kick via
   * {@link OutgoingService.stopEnqueueKick} without changing this boot flag.
   */
  readonly engineEnabled: boolean;
  readonly admissionStore: AdmissionStore;
  readonly messageStore: MessageStore;
  readonly moves: StageMoves;
  readonly metrics: MetricsRecorder;
};

/**
 * Redis-backed outgoing using plugin `initialQueueKey` for the initial queue.
 *
 * @param options - Registry, delivery, baseService, in-flight set, engine gate, stores, moves, metrics
 */
export function createOutgoingService(options: CreateOutgoingServiceOptions): OutgoingService {
  const {
    registry,
    delivery,
    baseService,
    inFlightSends,
    engineEnabled,
    admissionStore,
    messageStore,
    moves,
    metrics,
  } = options;

  /** Boot gate (`engineEnabled`); shutdown clears this so enqueue no longer kicks. */
  let kickDistribute = engineEnabled;

  /**
   * Whether this queue may yield a message under the plugin's admission strategy.
   *
   * @param plugin - Owning delivery plugin (`admission`)
   * @param queueKey - Initial-queue Redis key being considered
   */
  async function _canAdmit(plugin: DeliveryPlugin, queueKey: string): Promise<boolean> {
    const { admission } = plugin;

    switch (admission.strategy) {
      case 'spacing': {
        const lockKey = redisKeys.lockForQueue(queueKey);
        const lockAcquired = await admissionStore.lockQueueForTimeMs(
          lockKey,
          admission.minIntervalMs,
        );
        return lockAcquired !== null;
      }
      case 'concurrency': {
        const rateLimitKey = buildConcurrencyRateLimitKey(queueKey);
        if (!rateLimitKey) return false;
        const tracked = await admissionStore.getConcurrencyRateLimitCount(rateLimitKey);
        if (tracked >= admission.maxInFlight) {
          const liveCount = await admissionStore.validateAndCleanConcurrencyRateLimit(rateLimitKey);
          if (liveCount >= admission.maxInFlight) return false;
        }
        // Slot claim is atomic with the pick (fetch-next Lua). This is only the dead-member sweep.
        return true;
      }
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
      }, 'sendOne slow; its ns deadline was held off while we waited');
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
   * Distribution strategy is plugin-declared (ADR-006): spacing lock or concurrency
   * cap — never inferred from the human `kind` segment of the queue key.
   */
  async function distributeToNetworkServers(): Promise<void> {
    const activeQueues = await moves.listReadyQueues();

    await Promise.all(activeQueues.map(async queueKey => {
      const pluginId = getPluginIdFromInitialQueueKey(queueKey);
      if (!pluginId) return;

      const plugin = registry.get(pluginId);
      if (!plugin || plugin.deliveryPattern === 'NONE') return;

      const admitted = await _canAdmit(plugin, queueKey);
      if (!admitted) return;

      const concurrencyRateLimit = plugin.admission.strategy === 'concurrency'
        ? {
          key: buildConcurrencyRateLimitKey(queueKey) ?? '',
          max: plugin.admission.maxInFlight,
        }
        : undefined;

      const messageToSend = await moves.pickIntoNs(queueKey, plugin, concurrencyRateLimit);
      if (!messageToSend) return;

      // If not a retry, notify the adopter that the message is getting handled.
      // (The message status is already 'SENT_TO_NS'.) Await Redis enqueue only.
      if (!messageToSend.retryCount) {
        await baseService.emitDeliveryEvent(messageToSend);
      }

      // Track the whole send-and-transition so a due ns tick cannot retry while
      // we still hold the member (ADR-008 §8). Register before the event loop turns.
      void inFlightSends.track(
        messageToSend.id,
        _sendOneToNetworkServer(plugin, messageToSend),
      ).catch(err => {
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

    const claimed = await moves.claimFromQueue(queueKey, message.id);
    if (!claimed) return false;

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
    const messages = await messageStore.getAllMessagesForCorrelationId(correlationId);

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

      const message = await messageStore.enqueueDeviceMessage(
        create,
        queueKey,
        delivery.messageTtlSeconds,
      );

      // Fire-and-forget: try a distribute tick after enqueue.
      if (kickDistribute) {
        void distributeToNetworkServers().catch(err => {
          logger.error({ module: 'outgoing', err }, 'distribute after enqueue failed');
        });
      }

      return message;
    },

    getByCorrelationId(correlationId: string): Promise<DeviceMessage | null> {
      return messageStore.getMessageFromCorrelationId(correlationId);
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

    drainInFlightSends(budgetMs: number): Promise<number> {
      return inFlightSends.drain(budgetMs);
    },

    stopEnqueueKick(): void {
      kickDistribute = false;
    },
  };
}
