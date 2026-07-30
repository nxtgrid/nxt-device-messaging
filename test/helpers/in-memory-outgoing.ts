/**
 * @fileoverview In-memory {@link Outgoing} for HTTP unit tests (no Valkey).
 */

import { ulid } from 'ulid';

import { UnknownPluginError, type Outgoing } from '../../src/engine/outgoing.js';
import type { CreateDeviceMessage, DeviceMessage, PluginId } from '../../src/lib/device-message/types.js';

export type InMemoryOutgoingOptions = {
  /** When set, enqueue throws {@link UnknownPluginError} for other ids. */
  readonly knownPluginIds?: readonly PluginId[];
};

/** Process-local Map-backed outgoing for route / app unit tests. */
export function createInMemoryOutgoing(options: InMemoryOutgoingOptions = {}): Outgoing {
  const known = options.knownPluginIds !== undefined
    ? new Set(options.knownPluginIds)
    : undefined;
  const byCorrelationId = new Map<string, DeviceMessage>();

  return {
    async enqueue(create: CreateDeviceMessage): Promise<DeviceMessage> {
      if (known !== undefined && !known.has(create.pluginId)) {
        throw new UnknownPluginError(create.pluginId);
      }

      const message: DeviceMessage = {
        ...create,
        id: ulid(),
        deliveryQueueId: '',
        deliveryStatus: 'QUEUED',
        retryCount: 0,
        failureHistory: [],
      };
      if (create.correlationId !== undefined) {
        byCorrelationId.set(create.correlationId, message);
      }
      return message;
    },

    async getByCorrelationId(correlationId: string): Promise<DeviceMessage | null> {
      return byCorrelationId.get(correlationId) ?? null;
    },
  };
}
