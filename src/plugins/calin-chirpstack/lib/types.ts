/**
 * @fileoverview ChirpStack HTTP-integration event shapes + CALIN frame constants.
 *
 * Port of legacy `adapters/calin-lorawan/lib/types.ts`. Field names on our decoded
 * / correlator side are camelCase (ADR-003); ChirpStack webhook payloads keep
 * vendor casing (`deviceInfo`, `devEui`, …).
 *
 * `LorawanCalinJoinEvent` (and siblings) document the vendor shapes even when a
 * handler only needs a subset of fields — keep them for local development.
 */

import type {
  CommandType,
  FailureContext,
  MessageResponseStatus,
} from '../../../lib/device-message/types.js';

/** Gateway observation from a ChirpStack uplink `rxInfo[]` entry. */
export type GatewayInfoFromChirpStack = {
  gatewayId: string;
  snr: number;
  rssi: number;
};

/** Join notification — meter joined; NS assigned `devAddr`; no uplink payload. */
export type LorawanCalinJoinEvent = {
  // Identifiers
  deduplicationId: string;

  // Device
  deviceInfo: {
    devEui: string;
  };
  devAddr: string;
};

/** Downlink tx-ack — gateway confirmed it radiated the frame. */
export type LorawanCalinDownEvent = {
  // Identifiers
  queueItemId?: string;
  downlinkId: string;

  // Device
  deviceInfo: {
    devEui: string;
  };
};

/** Confirmed-data uplink ACK from the meter (may race the data uplink). */
export type LorawanCalinAckEvent = {
  // Identifiers
  queueItemId: string;
  deduplicationId: string;

  // Device
  deviceInfo: {
    devEui: string;
  };

  // Acknowledgement
  acknowledged: boolean;
};

/** Data uplink carrying base64 CALIN frame bytes. */
export type LorawanCalinUpEvent = {
  // Identifiers
  deduplicationId: string;

  // Device
  deviceInfo: {
    devEui: string;
  };
  devAddr: string;

  // Gateway
  rxInfo: GatewayInfoFromChirpStack[];

  // Acknowledgement
  // confirmed: boolean; needed?

  // Response data
  data: string;
};

/** Structurally narrowed ChirpStack integration event union for this plugin. */
export type LorawanCalinEvent =
  | LorawanCalinJoinEvent
  | LorawanCalinDownEvent
  | LorawanCalinAckEvent
  | LorawanCalinUpEvent;

/**
 * Result of decoding a CALIN uplink payload.
 * `null` when the frame is invalid / unsupported (caller drops the event).
 */
export type DecodedLorawanCalinEvent = {
  status: MessageResponseStatus;
  data: Record<string, unknown>;
  failureContext?: FailureContext;
  unsolicitedEventType?: CommandType;
};

/** CALIN DL/T 645-style frame markers. */
export const CalinMetaBytes = {
  HEADER_BYTE: 0x68,
  END_BYTE: 0x16,
} as const;

// Status / exception bytes seen on the wire (reference — not yet decoded as a map):
// 0F 超功率    power limit breached
// 24 电量用完  credit exhausted
// 26 强制拉闸  remote switched off
// 27 超电压    over voltage
// 2D 未激活    meter not activated
// 2E 窃电      tamper(cover lifted)
// 2F 低电压    (low voltage)
