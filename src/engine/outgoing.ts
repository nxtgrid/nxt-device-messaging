/**
 * @fileoverview Outgoing command surface: enqueue, get-by-correlation, cancel, distribute.
 *
 * Unit 5.3 — `distributeToNetworkServers` + named admission (ADR-006 D3).
 * Stops before `sendOne` / post-send PUSH|PULL moves (Unit 5.4).
 */

import type { DeliveryConfig } from '../config/schema.js';
import { QUEUE_RETRY_KEY, moveQueue } from '../lib/queue-moving.js';
import { redisRepo } from '../lib/redis-repository/index.js';
import { redisKeys } from '../lib/redis-repository/keys.js';
import type {
  CancelMessageResult,
  CreateDeviceMessage,
  DeviceMessage,
  PluginId,
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
import { emitDeliveryEvent } from './base.js';

/**
 * Thrown when enqueue names a plugin that is not registered / enabled.
 * HTTP maps this to 400.
 */
export class UnknownPluginError extends Error {
  readonly pluginId: PluginId;

  constructor(pluginId: PluginId) {
    super(`Unknown or disabled pluginId: ${ pluginId }`);
    this.name = 'UnknownPluginError';
    this.pluginId = pluginId;
  }
}

/**
 * Outgoing command operations used by HTTP (and later by the engine).
 * Wired at the composition root (`main.ts`); unit tests inject a fake.
 */
export type Outgoing = {
  enqueue(create: CreateDeviceMessage): Promise<DeviceMessage>;
  getByCorrelationId(correlationId: string): Promise<DeviceMessage | null>;
  cancelOne(correlationId: string): Promise<CancelMessageResult>;
  cancelMany(correlationIds: readonly string[]): Promise<CancelMessageResult[]>;
  /**
   * One distribute tick: admit + pick into NS queue. Does not call `sendOne` (Unit 5.4).
   * Timer wiring lands in Unit 5.6; tests may invoke this directly.
   */
  distributeToNetworkServers(): Promise<void>;
};

/** Dependencies for {@link createOutgoing}. */
export type CreateOutgoingOptions = {
  readonly registry: PluginRegistry;
  readonly delivery: DeliveryConfig;
  /**
   * When true (default), fire-and-forget {@link Outgoing.distributeToNetworkServers}
   * after a successful enqueue. Set false in tests that need the message to remain
   * `QUEUED` (e.g. cancel smoke).
   */
  readonly kickDistributeOnEnqueue?: boolean;
};

/**
 * Redis-backed outgoing using plugin `initialQueueKey` for the initial queue.
 *
 * @param options - Registry, delivery knobs, and optional enqueue-kick flag
 */
export function createOutgoing(options: CreateOutgoingOptions): Outgoing {
  const {
    registry,
    delivery,
    kickDistributeOnEnqueue = true,
  } = options;

  /**
   * Whether this queue may yield a message under the plugin's admission strategy.
   */
  async function _canAdmit(
    plugin: DeviceMessagingPlugin,
    queueKey: string,
  ): Promise<boolean> {
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
          const liveCount =
            await redisRepo.validateAndCleanConcurrencyRateLimit(rateLimitKey);
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
   */
  async function _onClaimAfterPick(
    plugin: DeviceMessagingPlugin,
    queueKey: string,
    messageId: string,
  ): Promise<void> {
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
   * Process all initial queues that have work: admit, pick into NS, emit first-send event.
   *
   * Distribution strategy is plugin-declared (ADR-006): spacing lock, concurrency cap,
   * or custom hooks — never inferred from the human `kind` segment of the queue key.
   *
   * Uses distributed locking (spacing) / concurrency rate-limit keys so concurrent ticks
   * do not over-admit the same bottleneck.
   *
   * Does **not** call `sendOne` — that is Unit 5.4.
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

      const messageToSend = await moveQueue.pickNextAndMoveToNs(queueKey, delivery);
      if (!messageToSend) return;

      await _onClaimAfterPick(plugin, queueKey, messageToSend.id);

      // If not a retry, notify the adopter that the message is getting handled.
      // (The message status is already 'SENT_TO_NS'.)
      if (!messageToSend.retryCount) {
        emitDeliveryEvent(messageToSend);
      }

      // Unit 5.4: sendOneToNetworkServer(messageToSend) — stop before send.
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
  };
}
