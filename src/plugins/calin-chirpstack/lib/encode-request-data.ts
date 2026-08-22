/**
 * @fileoverview Encode enqueueable commands as CALIN downlink bytes.
 *
 * Wire token command is `TOP_UP_KWH` (via {@link isTokenCommand}).
 */

import { isTokenCommand } from '../../../lib/device-message/command-types.js';
import type {
  CommandType,
  PhaseEnum,
  SetDatePayload,
  SetTimePayload,
} from '../../../lib/device-message/types.js';
import { CalinMetaBytes } from './types.js';

type RequestPayload = SetDatePayload | SetTimePayload;

type ToEncode = {
  /** Hex string device id (e.g. meter serial used in the CALIN address). */
  deviceIdentifier: string;
  devicePhase: PhaseEnum;
  requestType: CommandType;
  /** Hex token string when delivering a token command. */
  token?: string;
  /** Required for SET_DATE / SET_TIME. */
  payload?: RequestPayload;
};

type CommandConfig = {
  controlCode: number;
  dataIdentifier: number[];
  rawWriteData: number[];
  requiresPassword: boolean;
};

/**
 * Encode a command into CALIN frame bytes for ChirpStack enqueue.
 *
 * @returns Byte array, or `null` when the command / payload cannot be encoded
 */
export function encodeRequestData({
  deviceIdentifier,
  devicePhase,
  requestType,
  token,
  payload,
}: ToEncode): number[] | null {
  // For READ_POWER_LIMIT we use DLMS, which is made of fixed strings anyway
  if (requestType === 'READ_POWER_LIMIT') {
    return encodeDlms(requestType) ?? null;
  }

  // Meter address: 6 bytes little-endian from hex (pad short 11-digit refs to 12)
  const deviceEuiBytes = hexToBytes(deviceIdentifier.padStart(12, '0'));
  if (!deviceEuiBytes || deviceEuiBytes.length !== 6) return null;
  deviceEuiBytes.reverse();

  const frameHeader = [
    CalinMetaBytes.HEADER_BYTE,
    ...deviceEuiBytes,
    0x68, // Second frame header
  ];

  const passwordBytes = [ 0x00, 0x00, 0x00, 0x00 ];

  const commandConfig = determineCommandConfig({
    requestType,
    token,
    devicePhase,
    payload,
  });
  if (!commandConfig) return null;

  const { controlCode, dataIdentifier, rawWriteData, requiresPassword } = commandConfig;

  const dataIdentifierBytes = dataIdentifier
    .map(byte => (byte + 0x33) & 0xFF)
    .reverse();

  const writeBytes = requiresPassword
    ? [
      ...passwordBytes.map(byte => (byte + 0x33) & 0xFF).reverse(),
      ...rawWriteData.map(byte => (byte + 0x33) & 0xFF).reverse(),
    ]
    : rawWriteData;

  const dataSize = 0x02 + writeBytes.length;

  const frameBody = [
    ...frameHeader,
    controlCode,
    dataSize,
    ...dataIdentifierBytes,
    ...writeBytes,
  ];

  const checksum = frameBody.reduce((sum, byte) => sum + byte, 0) % 256;

  return [
    ...frameBody,
    checksum,
    CalinMetaBytes.END_BYTE,
  ];
}

function determineCommandConfig({
  requestType,
  token,
  devicePhase,
  payload,
}: {
  requestType: CommandType;
  token?: string;
  devicePhase: PhaseEnum;
  payload?: RequestPayload;
}): CommandConfig | null {
  if (isTokenCommand(requestType)) {
    if (!token) return null;

    const tokenBytes = hexToBytes(token);
    if (!tokenBytes) return null;

    const rawWriteData = tokenBytes
      .map(byte => (byte + 0x33) & 0xFF)
      .reverse();

    return {
      controlCode: 0x00, // Token
      dataIdentifier: [ 0xa1, 0x20 ],
      rawWriteData,
      requiresPassword: false,
    };
  }

  switch (requestType) {
    // Control operations
    case 'TURN_ON': // Close the meter relay (provide power)
      return {
        controlCode: 0x04, // Writing
        dataIdentifier: [ 0xc0, 0x3d ],
        rawWriteData: [ 0x96 ],
        requiresPassword: true,
      };
    case 'TURN_OFF': // Open the meter relay (stop power output)
      return {
        controlCode: 0x04, // Writing
        dataIdentifier: [ 0xc0, 0x3c ],
        rawWriteData: [ 0x35 ],
        requiresPassword: true,
      };
    // Write operations
    case 'SET_DATE': {
      if (!isSetDatePayload(payload)) return null;
      const rawWriteData = encodeDateBytes(payload);
      if (!rawWriteData) return null;
      return {
        controlCode: 0x04, // Writing
        dataIdentifier: [ 0xc0, 0x10 ],
        rawWriteData,
        requiresPassword: true,
      };
    }
    case 'SET_TIME': {
      if (!isSetTimePayload(payload)) return null;
      const rawWriteData = encodeTimeBytes(payload);
      if (!rawWriteData) return null;
      return {
        controlCode: 0x04, // Writing
        dataIdentifier: [ 0xc0, 0x11 ],
        rawWriteData,
        requiresPassword: true,
      };
    }
    // Reading operations
    case 'READ_CREDIT': // Credit remaining on meter
      return {
        controlCode: 0x01, // Reading
        dataIdentifier: [ 0xe4, 0x21 ],
        rawWriteData: [],
        requiresPassword: false,
      };
    // case 'READ_FRAUD_STATUS':
    //   return {
    //     controlCode: 0x01, // Reading
    //     dataIdentifier: [ 0xef, 0xf6 ],
    //     rawWriteData: [],
    //     requiresPassword: false,
    //   };
    // case 'READ_STATUS':
    //   return {
    //     controlCode: 0x01, // Reading
    //     dataIdentifier: [ 0xef, 0xf5 ],
    //     rawWriteData: [],
    //     requiresPassword: false,
    //   };
    case 'READ_DATE':
      return {
        controlCode: 0x01, // Reading
        dataIdentifier: [ 0xc0, 0x10 ],
        rawWriteData: [],
        requiresPassword: false,
      };
    case 'READ_TIME':
      return {
        controlCode: 0x01, // Reading
        dataIdentifier: [ 0xc0, 0x11 ],
        rawWriteData: [],
        requiresPassword: false,
      };
    // case 'READ_TOTAL_ACTIVE_KWH': // Total Active kWh Register
    //   return {
    //     controlCode: 0x01, // Reading
    //     dataIdentifier: [ 0x90, 0x10 ],
    //     rawWriteData: [],
    //     requiresPassword: false,
    //   };
    case 'READ_VOLTAGE':
      return {
        controlCode: 0x01,
        dataIdentifier: readVoltageByPhase(devicePhase),
        rawWriteData: [],
        requiresPassword: false,
      };
    case 'READ_POWER':
      return {
        controlCode: 0x01,
        dataIdentifier: readPowerByPhase(devicePhase),
        rawWriteData: [],
        requiresPassword: false,
      };
    case 'READ_CURRENT':
      return {
        controlCode: 0x01,
        dataIdentifier: readCurrentByPhase(devicePhase),
        rawWriteData: [],
        requiresPassword: false,
      };
    default:
      return null;
  }
}

function encodeDlms(requestType: CommandType): number[] | undefined {
  switch (requestType) {
    case 'READ_POWER_LIMIT':
      return [
        0x00, 0x01, 0x00, 0x66, 0x00, 0x01, 0x00, 0x0D, 0xC0, 0x01, 0xC1, 0x00,
        0x47, 0x00, 0x00, 0x11, 0x00, 0x00, 0xFF, 0x03, 0x00,
      ];
  }
}

function readCurrentByPhase(phase: PhaseEnum): number[] {
  switch (phase) {
    case 'A':
      return [ 0xB6, 0x21 ];
    case 'B':
      return [ 0xB6, 0x22 ];
    case 'C':
      return [ 0xB6, 0x23 ];
  }
}

function readPowerByPhase(phase: PhaseEnum): number[] {
  switch (phase) {
    case 'A':
      return [ 0xB6, 0x30 ];
    case 'B':
      return [ 0xB6, 0x31 ];
    case 'C':
      return [ 0xB6, 0x32 ];
  }
}

function readVoltageByPhase(phase: PhaseEnum): number[] {
  switch (phase) {
    case 'A':
      return [ 0xB6, 0x11 ];
    case 'B':
      return [ 0xB6, 0x12 ];
    case 'C':
      return [ 0xB6, 0x13 ];
  }
}

function isSetDatePayload(payload?: RequestPayload): payload is SetDatePayload {
  return !!payload
    && typeof (payload as SetDatePayload).year === 'number'
    && typeof (payload as SetDatePayload).month === 'number'
    && typeof (payload as SetDatePayload).day === 'number';
}

/**
 * Encodes a date as 4 BCD bytes in the natural (year-first) order.
 *
 * The encoder pipeline applies (+0x33) per byte and then reverses the array,
 * so the meter receives bytes 12-15 as [weekday, day, month, year] — the
 * same layout the meter uses when reporting its date in READ_DATE responses.
 */
function encodeDateBytes({ year, month, day }: SetDatePayload): number[] | null {
  const fullYear = year < 100 ? 2000 + year : year;
  // Use UTC: DTO carries grid-local calendar values; treat as literal date.
  const weekday = new Date(Date.UTC(fullYear, month - 1, day)).getUTCDay();
  const yearBcd = toBcd(fullYear % 100);
  const monthBcd = toBcd(month);
  const dayBcd = toBcd(day);
  const weekdayBcd = toBcd(weekday);
  if (
    yearBcd === null
    || monthBcd === null
    || dayBcd === null
    || weekdayBcd === null
  ) {
    return null;
  }
  return [ yearBcd, monthBcd, dayBcd, weekdayBcd ];
}

function isSetTimePayload(payload?: RequestPayload): payload is SetTimePayload {
  return !!payload
    && typeof (payload as SetTimePayload).hour === 'number'
    && typeof (payload as SetTimePayload).minute === 'number'
    && (
      (payload as SetTimePayload).second === undefined
      || typeof (payload as SetTimePayload).second === 'number'
    );
}

/**
 * Encodes a time-of-day as 3 BCD bytes in the natural (hour-first) order.
 * Pipeline (+0x33 + reverse) yields meter layout [second, minute, hour].
 */
function encodeTimeBytes({
  hour,
  minute,
  second = 0,
}: SetTimePayload): number[] | null {
  const hourBcd = toBcd(hour);
  const minuteBcd = toBcd(minute);
  const secondBcd = toBcd(second);
  if (hourBcd === null || minuteBcd === null || secondBcd === null) {
    return null;
  }
  return [ hourBcd, minuteBcd, secondBcd ];
}

/** Encodes a 0–99 decimal value as a single BCD byte (e.g. 26 → 0x26). */
function toBcd(value: number): number | null {
  if (!Number.isInteger(value) || value < 0 || value > 99) return null;
  return (Math.floor(value / 10) << 4) | (value % 10);
}

/** Parse an even-length hex string into bytes. Returns `null` when malformed. */
function hexToBytes(hex: string): number[] | null {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
  return hex.match(/.{2}/g)!.map(pair => parseInt(pair, 16));
}
