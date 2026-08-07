/**
 * @fileoverview `calin-chirpstack` incoming facet (Unit 10.1 scaffold).
 *
 * Real PUSH ingress (tx-ack / up / ack / join + correlator) ports in Unit 10.5.
 */

import type { ParsedIncomingEvent } from '../../lib/device-message/types.js';
import type { DeviceMessagingPlugin } from '../plugin.interface.js';

/**
 * Build a placeholder incoming facet until Unit 10.5.
 *
 * @returns Incoming SPI object whose `handle` throws until the ChirpStack port lands
 */
export function createCalinChirpstackIncoming(): DeviceMessagingPlugin['incoming'] {
  return {
    handle(_event: unknown): ParsedIncomingEvent | null {
      throw new Error('calin-chirpstack incoming not ported yet (Unit 10.5)');
    },
  };
}
