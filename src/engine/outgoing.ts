/**
 * @fileoverview Outgoing command surface: enqueue, get-by-correlation, cancel.
 *
 * Unit 5.2 — distribute stays a no-op until 5.3.
 */

import { QUEUE_RETRY_KEY } from '../lib/queue-moving.js';
import { redisRepo } from '../lib/redis-repository/index.js';
import type {
  CancelMessageResult,
  CreateDeviceMessage,
  DeviceMessage,
  PluginId,
} from '../lib/device-message/types.js';
import type { PluginRegistry } from '../plugins/registry.js';

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
};

/**
 * Redis-backed outgoing using plugin `bottleneckKey` for the initial queue.
 * Does not call distribute.
 *
 * @param registry - Enabled plugins (from boot `runtime` or a test registry)
 */
export function createOutgoing(registry: PluginRegistry): Outgoing {
  /**
   * Attempt to cancel a single device message from its current queue.
   *
   * Uses ZREM as an atomic claim: if ZREM returns 1 we own the message and
   * proceed with full cleanup. If it returns 0 the message has already been
   * picked up by the distributor or reaper, so we leave it alone.
   *
   * Only `QUEUED` / `TO_RETRY` are cancellable — anything further along has
   * already been handed off to the network server. `QUEUED` resolves the
   * bottleneck queue through the registered plugin (`bottleneckKey` — replaces
   * legacy `queueInitial`).
   *
   * @param message - The device message to cancel
   * @returns true if the message was successfully removed, false otherwise
   */
  async function cancelOneMessage(message: DeviceMessage): Promise<boolean> {
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
      queueKey = plugin.bottleneckKey({
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
  async function cancelOneByCorrelationId(
    correlationId: string,
  ): Promise<CancelMessageResult> {
    const messages = await redisRepo.getAllMessagesForCorrelationId(correlationId);

    if (messages.length === 0) {
      return { correlationId, result: 'NOT_FOUND' };
    }

    const outcomes = await Promise.all(messages.map(message => cancelOneMessage(message)));
    const allCancelled = outcomes.every(Boolean);
    const result = allCancelled ? 'CANCELLED' : 'NOT_CANCELLABLE';

    return { correlationId, result };
  }

  return {
    async enqueue(create: CreateDeviceMessage): Promise<DeviceMessage> {
      const plugin = registry.get(create.pluginId);
      if (!plugin) throw new UnknownPluginError(create.pluginId);

      const queueKey = plugin.bottleneckKey({
        networkId: create.networkId,
        device: create.device,
      });

      return redisRepo.enqueueDeviceMessage(create, queueKey);
    },

    getByCorrelationId(correlationId: string): Promise<DeviceMessage | null> {
      return redisRepo.getMessageFromCorrelationId(correlationId);
    },

    cancelOne(correlationId: string): Promise<CancelMessageResult> {
      return cancelOneByCorrelationId(correlationId);
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
      return Promise.all(correlationIds.map(id => cancelOneByCorrelationId(id)));
    },
  };
}
