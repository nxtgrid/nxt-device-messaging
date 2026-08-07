/**
 * @fileoverview `calin-chirpstack` outgoing facet (Unit 10.1 scaffold).
 *
 * Holds the shared {@link ChirpstackClient} from Unit 10.2. Real send /
 * remote-status / gRPC error mapping ports in Unit 10.4.
 */

import type {
  DeviceMessage,
  FailureContext,
} from '../../lib/device-message/types.js';
import type { ChirpstackClient } from '../_shared/chirpstack-repository/index.js';
import type { DeviceMessagingPlugin } from '../plugin.interface.js';

/**
 * Build a placeholder outgoing facet until Unit 10.4.
 *
 * @param deps.client - Shared ChirpStack gRPC client (unused until 10.4)
 * @returns Outgoing SPI object whose send methods throw until the port lands
 */
export function createCalinChirpstackOutgoing(deps: {
  readonly client: ChirpstackClient;
}): DeviceMessagingPlugin['outgoing'] {
  void deps.client;

  return {
    async sendOne(_message: DeviceMessage): Promise<string> {
      throw new Error('calin-chirpstack outgoing not ported yet (Unit 10.4)');
    },

    getRemoteStatus(_message: DeviceMessage): { deliveryStatus: string } {
      throw new Error('calin-chirpstack getRemoteStatus not ported yet (Unit 10.4)');
    },

    parseError(err: unknown): FailureContext {
      if (err instanceof Error) {
        return { reason: err.message };
      }
      return { reason: String(err) };
    },
  };
}
