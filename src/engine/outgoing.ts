/**
 * @fileoverview Thin outgoing surface: enqueue + get-by-correlation (Intermezzo I3).
 *
 * Partial Unit 5.2 — distribute stays a no-op until 5.3. Cancel is I4 / remaining 5.2.
 */

import { redisRepo } from '../lib/redis-repository/index.js';
import type { CreateDeviceMessage, DeviceMessage, PluginId } from '../lib/types.js';
import { pluginRegistry } from '../runtime.js';

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
};

/**
 * Redis-backed outgoing using plugin `bottleneckKey` for the initial queue.
 * Uses boot {@link pluginRegistry} from `runtime` (same as `engine/base`).
 * Does not call distribute.
 */
export function createOutgoing(): Outgoing {
  return {
    async enqueue(create: CreateDeviceMessage): Promise<DeviceMessage> {
      const plugin = pluginRegistry.get(create.pluginId);
      if (plugin === undefined) {
        throw new UnknownPluginError(create.pluginId);
      }

      const queueKey = plugin.bottleneckKey({
        networkId: create.networkId,
        device: create.device,
      });

      return redisRepo.enqueueDeviceMessage(create, queueKey);
    },

    getByCorrelationId(correlationId: string): Promise<DeviceMessage | null> {
      return redisRepo.getMessageFromCorrelationId(correlationId);
    },
  };
}
