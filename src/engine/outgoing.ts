/**
 * @fileoverview Outgoing command surface: enqueue, get-by-correlation, cancel,
 * distribute, send, resolution cycle.
 *
 * Unit 5.4 — fire-and-forget `sendOne` + post-send PUSH|PULL queue moves.
 * Unit 5.6 — `runMessageResolutionCycle` (timer wiring in `timers.ts`).
 */

import type { DeliveryConfig } from '../config/schema.js';
import {
  getPushTimeouts,
  maybeExtendMessageInRelayNodeQueue,
} from '../lib/lifecycle.push.js';
import { getPullTimeouts } from '../lib/lifecycle.pull.js';
import { QUEUE_NS_KEY, QUEUE_RETRY_KEY, moveQueue } from '../lib/queue-moving.js';
import { moveQueuePull } from '../lib/queue-moving.pull.js';
import { QUEUE_RELAY_NODE_KEY, moveQueuePush } from '../lib/queue-moving.push.js';
import { redisRepo } from '../lib/redis-repository/index.js';
import { redisKeys } from '../lib/redis-repository/keys.js';
import type {
  CancelMessageResult,
  CreateDeviceMessage,
  DeviceMessage,
} from '../lib/device-message/types.js';
import {
  buildConcurrencyRateLimitKey,
  getPluginIdFromInitialQueueKey,
} from '../plugins/initial-queue-key.js';
import type {
  DeviceMessagingPlugin,
  DistributeCtx,
} from '../plugins/plugin.interface.js';
import type { PluginRegistry } from '../plugins/registry.js';
import { emitDeliveryEvent, type BaseService } from './base.js';
import { UnknownPluginError, UnsupportedCommandTypeError } from './errors.js';

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
   * Also invoked at the end of {@link OutgoingService.runMessageResolutionCycle}.
   * Tests may call this directly.
   */
  distributeToNetworkServers(): Promise<void>;
  /**
   * One resolution-cycle tick: NS/PUSH/PULL timeouts, retry requeue, then distribute.
   * Timer wiring lands in `startEngineTimers`; tests may invoke this directly.
   */
  runMessageResolutionCycle(): Promise<void>;
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
};

/**
 * Redis-backed outgoing using plugin `initialQueueKey` for the initial queue.
 *
 * @param options - Registry, delivery, baseService, and optional enqueue-kick flag
 */
export function createOutgoingService(options: CreateOutgoingServiceOptions): OutgoingService {
  const { registry, delivery, baseService, kickDistributeOnEnqueue = true } = options;

  /**
   * Concurrency admission track key for retry/cleanup, or undefined for spacing/custom.
   *
   * @param plugin - Owning plugin (`admission.strategy`)
   * @param message - Message whose initial queue identity drives the key
   */
  function _concurrencyRateLimitKeyFor(plugin: DeviceMessagingPlugin, message: DeviceMessage): string | undefined {
    if (plugin.admission.strategy !== 'concurrency') return undefined;
    const queueKey = plugin.initialQueueKey({ networkId: message.networkId, device: message.device });
    return buildConcurrencyRateLimitKey(queueKey);
  }

  /**
   * Whether this queue may yield a message under the plugin's admission strategy.
   *
   * @param plugin - Owning plugin (`admission`)
   * @param queueKey - Initial-queue Redis key being considered
   */
  async function _canAdmit(plugin: DeviceMessagingPlugin, queueKey: string): Promise<boolean> {
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
   * @param plugin - Owning plugin (`admission`)
   * @param queueKey - Initial-queue Redis key the message was picked from
   * @param messageId - ULID of the claimed message
   */
  async function _onClaimAfterPick(plugin: DeviceMessagingPlugin, queueKey: string, messageId: string): Promise<void> {
    const { admission } = plugin;

    switch (admission.strategy) {
      case 'spacing':
        return;
      case 'concurrency': {
        const rateLimitKey = buildConcurrencyRateLimitKey(queueKey);
        if (!rateLimitKey) return;
        await redisRepo.addToConcurrencyRateLimit(rateLimitKey, messageId);
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
   * On failure, {@link BaseService.retryOrFail} from the NS queue (with concurrency key when needed).
   *
   * @param plugin - Owning plugin (`outgoing.sendOne` + tuning)
   * @param message - The message to send (already in NS queue)
   */
  async function _sendOneToNetworkServer(plugin: DeviceMessagingPlugin, message: DeviceMessage): Promise<void> {
    let deliveryQueueId: string;

    try {
      deliveryQueueId = await plugin.outgoing.sendOne(message);
    }
    catch (err) {
      await baseService.retryOrFail(
        message.id,
        QUEUE_NS_KEY,
        plugin.outgoing.parseError(err),
        { concurrencyRateLimitKey: _concurrencyRateLimitKeyFor(plugin, message) },
      );
      return;
    }

    if (!deliveryQueueId) {
      await baseService.retryOrFail(
        message.id,
        QUEUE_NS_KEY,
        {
          reason: 'Plugin returned an empty deliveryQueueId after sendOne',
          skipRetry: true,
        },
        { concurrencyRateLimitKey: _concurrencyRateLimitKeyFor(plugin, message) },
      );
      return;
    }

    if (plugin.deliveryPattern === 'PULL') {
      await moveQueuePull.fromNsToAwaitingTask({
        id: message.id,
        deliveryQueueId,
        pluginId: plugin.id,
        tuning: plugin.tuning,
        messageTtlSeconds: delivery.messageTtlSeconds,
      });
      return;
    }

    await moveQueuePush.fromNsToRelayNode({
      id: message.id,
      deliveryQueueId,
      tuning: plugin.tuning,
      messageTtlSeconds: delivery.messageTtlSeconds,
    });
  }

  /**
   * One lifecycle tick:
   * 1. NS queue timeouts → retryOrFail
   * 2. PUSH GW/Device timeouts (GW may extend via remote status) → retryOrFail
   * 3. PULL age timeouts → emitDeliveryEvent (already cleaned up)
   * 4. Retry queue → requeue ready messages
   * 5. Distribute (fire-and-forget)
   */
  async function runMessageResolutionCycle(): Promise<void> {
    const now = Date.now();

    // 1. Shared: NS queue timeout (both PUSH and PULL before branching)
    const nsZombieIds = await redisRepo.getExpiredMessagesInQueue(QUEUE_NS_KEY, now);
    for (const messageId of nsZombieIds) {
      await baseService.retryOrFail(messageId, QUEUE_NS_KEY, {
        reason: 'Timed out waiting for Network Server to accept message',
      });
    }

    // 2. PUSH: relay-node + device timeouts
    const pushTimeouts = await getPushTimeouts(now);
    for (const { messageId, queueKey, reason } of pushTimeouts) {
      if (queueKey === QUEUE_RELAY_NODE_KEY) {
        const message = await redisRepo.getMessageById(messageId);
        if (message) {
          const plugin = registry.get(message.pluginId)!;
          const extended = await maybeExtendMessageInRelayNodeQueue(
            messageId,
            message,
            plugin,
          );
          if (extended) continue;
        }
      }
      await baseService.retryOrFail(messageId, queueKey, { reason });
    }

    // 3. PULL: age-based permanent failure (cleanup already done inside getPullTimeouts)
    const pullPluginIds = registry.getByDeliveryPattern('PULL').map(plugin => plugin.id);
    const pullTimeouts = await getPullTimeouts(now, pullPluginIds);
    for (const { message } of pullTimeouts) {
      emitDeliveryEvent(message);
    }

    // 4. Requeue messages whose backoff has elapsed
    const readyToRetryIds = await redisRepo.getExpiredMessagesInQueue(QUEUE_RETRY_KEY, now);
    for (const messageId of readyToRetryIds) {
      await baseService.requeueMessage(messageId);
    }

    // 5. Kick distribution (not awaited — tick completes at handoff)
    void distributeToNetworkServers().catch(err => {
      console.error('[runMessageResolutionCycle] distributeToNetworkServers failed', err);
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
      if (!plugin) return;

      const admitted = await _canAdmit(plugin, queueKey);
      if (!admitted) return;

      const messageToSend = await moveQueue.pickNextAndMoveToNs(queueKey, plugin.tuning);
      if (!messageToSend) return;

      await _onClaimAfterPick(plugin, queueKey, messageToSend.id);

      // If not a retry, notify the adopter that the message is getting handled.
      // (The message status is already 'SENT_TO_NS'.)
      if (!messageToSend.retryCount) {
        emitDeliveryEvent(messageToSend);
      }

      // Fire-and-forget: distribute considers the handoff done once picked.
      void _sendOneToNetworkServer(plugin, messageToSend).catch(err => {
        console.error('[distributeToNetworkServers] sendOne failed', err);
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

    let queueKey: string | undefined;
    if (deliveryStatus === 'TO_RETRY') {
      queueKey = QUEUE_RETRY_KEY;
    }
    else {
      const plugin = registry.get(message.pluginId);
      if (!plugin) return false;
      queueKey = plugin.initialQueueKey({
        networkId: message.networkId,
        device: message.device,
      });
    }

    const removed = await redisRepo.removeMessageFromQueue(queueKey, message.id);
    if (removed === 0) return false;

    await redisRepo.messageFullCleanup(message);
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
      if (!plugin.supportedCommandTypes.includes(create.commandType)) {
        throw new UnsupportedCommandTypeError(create.pluginId, create.commandType);
      }

      const queueKey = plugin.initialQueueKey({
        networkId: create.networkId,
        device: create.device,
      });

      const message = await redisRepo.enqueueDeviceMessage(create, queueKey);

      // Fire-and-forget: try a distribute tick after enqueue.
      if (kickDistributeOnEnqueue) {
        void distributeToNetworkServers().catch(err => {
          console.error('[enqueue] distributeToNetworkServers failed', err);
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
    runMessageResolutionCycle,
  };
}
