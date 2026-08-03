/**
 * @fileoverview In-memory {@link OutgoingService} for HTTP unit tests (no Valkey).
 */

import { ulid } from 'ulid';

import { UnknownPluginError } from '../../src/engine/errors.js';
import type { OutgoingService } from '../../src/engine/outgoing.js';
import type {
  CancelMessageResult,
  CreateDeviceMessage,
  DeviceMessage,
  PluginId,
} from '../../src/lib/device-message/types.js';

export type InMemoryOutgoingServiceOptions = {
  /** When set, enqueue throws {@link UnknownPluginError} for other ids. */
  readonly knownPluginIds?: readonly PluginId[];
};

/** Process-local Map-backed outgoing for route / app unit tests. */
export function createInMemoryOutgoingService(
  options: InMemoryOutgoingServiceOptions = {},
): OutgoingService {
  const known = options.knownPluginIds !== undefined
    ? new Set(options.knownPluginIds)
    : undefined;
  const byCorrelationId = new Map<string, DeviceMessage>();

  const cancelOne = async (correlationId: string): Promise<CancelMessageResult> => {
    const message = byCorrelationId.get(correlationId);
    if (message === undefined) {
      return { correlationId, result: 'NOT_FOUND' };
    }
    if (message.deliveryStatus !== 'QUEUED' && message.deliveryStatus !== 'TO_RETRY') {
      return { correlationId, result: 'NOT_CANCELLABLE' };
    }
    byCorrelationId.delete(correlationId);
    return { correlationId, result: 'CANCELLED' };
  };

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

    cancelOne,

    async cancelMany(correlationIds: readonly string[]): Promise<CancelMessageResult[]> {
      return Promise.all(correlationIds.map(id => cancelOne(id)));
    },

    async distributeToNetworkServers(): Promise<void> {
      // no-op — HTTP unit tests do not exercise distribute
    },

    async runMessageResolutionCycle(): Promise<void> {
      // no-op — HTTP unit tests do not exercise the resolution cycle
    },
  };
}
