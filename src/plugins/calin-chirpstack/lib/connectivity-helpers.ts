/**
 * @fileoverview Pick the best gateway observation from ChirpStack `rxInfo`.
 *
 * Returns a {@link RelayNodeInfo} fragment for `device.relayNode`.
 */

import type { RelayNodeInfo } from '../../../lib/device-message/types.js';
import type { GatewayInfoFromChirpStack } from './types.js';

const signalSortFn = (
  left: GatewayInfoFromChirpStack,
  right: GatewayInfoFromChirpStack,
): number => {
  if (right.snr !== left.snr) {
    return right.snr - left.snr; // Prioritize higher SNR
  }
  return right.rssi - left.rssi; // Tie-breaker: higher RSSI (less negative)
};

/**
 * Select the gateway with the best signal from a ChirpStack `rxInfo` list.
 *
 * @param rxInfoList - Non-empty gateway observations from an uplink
 * @returns Best gateway as `device.relayNode` fields
 */
export function selectGatewayWithBestSignal(
  rxInfoList: readonly GatewayInfoFromChirpStack[],
): RelayNodeInfo {
  const sorted = [ ...rxInfoList ].sort(signalSortFn);
  const best = sorted[0]!;
  return {
    externalReference: best.gatewayId,
    snr: best.snr,
    rssi: best.rssi,
  };
}
