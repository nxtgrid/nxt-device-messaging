/**
 * @fileoverview `calin-chirpstack` outgoing facet (Unit 10.1 scaffold).
 *
 * Real send / remote-status / gRPC error mapping ports in Unit 10.4.
 */

import type {
  DeviceMessage,
  FailureContext,
} from '../../lib/device-message/types.js';
import type { DeviceMessagingPlugin } from '../plugin.interface.js';

/**
 * Build a placeholder outgoing facet until Unit 10.4.
 *
 * @returns Outgoing SPI object whose methods throw until the ChirpStack port lands
 */
export function createCalinChirpstackOutgoing(): DeviceMessagingPlugin['outgoing'] {
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
