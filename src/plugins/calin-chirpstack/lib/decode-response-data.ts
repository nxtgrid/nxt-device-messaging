/**
 * @fileoverview Decode CALIN uplink base64 frames from ChirpStack.
 *
 * `response.data` keys are **camelCase**.
 */

import type { PhaseEnum } from '../../../lib/device-message/types.js';
import { logger } from '../../../log.js';
import { CalinMetaBytes, type DecodedLorawanCalinEvent } from './types.js';

enum CalinControlCode {
  'READING',
  'READING_SUCCESS',
  'READING_FAILURE',
  'WRITING',
  'WRITING_SUCCESS',
  'WRITING_FAILURE',
  'SEND_TOKEN',
  'SEND_TOKEN_SUCCESS',
  'SEND_TOKEN_FAILURE',
}

const CONTROL_CODE_MAP: Record<number, CalinControlCode> = {
  // Request
  // 0x01: CalinControlCode.READING,
  // 0x04: CalinControlCode.WRITING,
  // 0x00: CalinControlCode.SEND_TOKEN,

  // Response
  0x81: CalinControlCode.READING_SUCCESS,
  0xC1: CalinControlCode.READING_FAILURE,
  0x84: CalinControlCode.WRITING_SUCCESS,
  0xC4: CalinControlCode.WRITING_FAILURE,
  0x80: CalinControlCode.SEND_TOKEN_SUCCESS,
  0xC0: CalinControlCode.SEND_TOKEN_FAILURE,
};

// RESPONSE TO USED TOKEN :: Buffer.from('aCM2MwNwBGjAATTIFg==', 'base64');
// <Buffer 68 23 36 33 03 70 04 68 c0 01 34 c8 16>
// Where c0 is the SEND_TOKEN_FAILURE

/**
 * Decodes a CALIN protocol uplink message from LoRaWAN bytes.
 *
 * Frame layout:
 * - Byte 0: Frame header (0x68)
 * - Bytes 1-6: Meter address (6 bytes, little-endian)
 * - Byte 7: Second frame header (0x68)
 * - Byte 8: Control code
 * - Byte 9: Data size
 * - Bytes 10-11: Data Identifier (DI)
 * - Bytes 12+: Data payload
 * - Byte N-2: Checksum
 * - Byte N-1: End byte (0x16)
 *
 * @param dataString - Base64 payload from ChirpStack `data`
 * @returns Decoded event, or `null` when the frame is invalid / unsupported
 */
export function decodeResponseData(
  dataString: string,
): DecodedLorawanCalinEvent | null {
  const bytes = Buffer.from(dataString, 'base64');

  if (bytes[0] === 0x00) {
    return {
      status: 'EXECUTION_SUCCESS',
      data: decodeDlms(bytes),
    };
  }

  if (
    bytes[0] !== CalinMetaBytes.HEADER_BYTE
    || bytes[7] !== CalinMetaBytes.HEADER_BYTE
    || bytes[bytes.length - 1] !== CalinMetaBytes.END_BYTE
  ) {
    logger.warn({
      module: 'calin-chirpstack.decode',
      hex: bytes.toString('hex'),
    }, 'invalid frame headers');
    return null;
  }

  const operation = CONTROL_CODE_MAP[bytes[8]!];
  if (operation === undefined) {
    logger.warn({
      module: 'calin-chirpstack.decode',
      controlCode: bytes[8],
    }, 'unmatched control code');
    return null;
  }

  const computedChecksum = bytes.subarray(0, bytes.length - 2)
    .reduce((sum, byte) => sum + byte, 0) % 256;
  const receivedChecksum = bytes[bytes.length - 2]!;
  if (computedChecksum !== receivedChecksum) {
    logger.warn({
      module: 'calin-chirpstack.decode',
      expected: computedChecksum,
      received: receivedChecksum,
    }, 'checksum mismatch');
    return null;
  }

  if (operation === CalinControlCode.SEND_TOKEN_SUCCESS) {
    return {
      status: 'EXECUTION_SUCCESS',
      data: { tokenAccepted: true },
    };
  }

  if (operation === CalinControlCode.SEND_TOKEN_FAILURE) {
    return {
      status: 'EXECUTION_FAILURE',
      data: { tokenAccepted: false },
      failureContext: {
        reason: 'Delivery was successful but the token was not accepted',
      },
    };
  }

  if (operation === CalinControlCode.WRITING_SUCCESS) {
    return {
      status: 'EXECUTION_SUCCESS',
      data: { onOffToggleAccepted: true },
    };
  }

  if (operation === CalinControlCode.WRITING_FAILURE) {
    return {
      status: 'EXECUTION_FAILURE',
      data: { onOffToggleAccepted: false },
      failureContext: {
        reason: 'Delivery was successful but the command was not (successfully) executed',
      },
    };
  }

  const dataIdentifier = '0x' + reverseAndCombine(bytes.subarray(10, 12))
    .toString(16)
    .toUpperCase()
    .padStart(4, '0');

  if (!Object.hasOwn(DATA_PROCESSOR_MAP, dataIdentifier)) {
    logger.warn({
      module: 'calin-chirpstack.decode',
      dataIdentifier,
      hex: bytes.toString('hex'),
    }, 'no parser for data identifier');
    return null;
  }

  const parser = DATA_PROCESSOR_MAP[dataIdentifier as keyof typeof DATA_PROCESSOR_MAP];
  const declaredDataSize = bytes[9]!;
  if (bytes.length < 12 + declaredDataSize) {
    logger.warn({
      module: 'calin-chirpstack.decode',
      dataIdentifier,
      declaredDataSize,
      frameLength: bytes.length,
    }, 'frame shorter than declared data size');
    return null;
  }
  const data = parser(bytes);

  // Special case read report — meter sends these automatically; we did not
  // dispatch a command to ask for one
  if (dataIdentifier === '0xC111') {
    return {
      status: 'EXECUTION_SUCCESS',
      data,
      unsolicitedEventType: 'READ_REPORT',
    };
  }

  if (operation === CalinControlCode.READING_SUCCESS) {
    return {
      status: 'EXECUTION_SUCCESS',
      data,
    };
  }

  return {
    status: 'EXECUTION_FAILURE',
    data,
    failureContext: {
      reason: 'Delivery was successful but the readout was not (successfully) executed',
    },
  };
}

/**
 * Decoder functions
 */

/** Currently only implements READ_POWER_LIMIT. */
function decodeDlms(bytes: Buffer): Record<string, unknown> {
  const last4Bytes = bytes.subarray(-4);
  return {
    powerLimit: hexArrayToNumber(last4Bytes), // Power limit in Watt
  };
}

const decodeReadVoltage = (phase: PhaseEnum) => (bytes: Buffer) => ({
  // Voltage (3 bytes, little-endian, BCD format: XXXX.XX V)
  // Note: Documentation suggests 4 bytes, but testing shows 3 bytes are used
  voltage: bcdToInteger(bytes.subarray(13, 16).map(subtract33H)) / 100,
  phase,
});

const decodeReadPower = (phase: PhaseEnum) => (bytes: Buffer) => ({
  // Power: bytes 12-15 (4 bytes, BCD format, divided by 10 for watts)
  power: bcdToInteger(bytes.subarray(12, 16).map(subtract33H)) / 10,
  phase,
});

const decodeReadCurrent = (phase: PhaseEnum) => (bytes: Buffer) => ({
  // Current: bytes 12-13 (2 bytes, BCD format, divided by 100 for amperes)
  // Note: Similar to voltage which uses 3 bytes, current uses 2 bytes
  current: bcdToInteger(bytes.subarray(12, 14).map(subtract33H)) / 100,
  phase,
});

// Processes Total Active kWh Register data (DI: 0x9010) — not wired yet
// function processTotalActiveKwhRead(bytes: Buffer) {
//   // Total Active Kwh Register (4 bytes, little-endian, BCD format: XXXXXX.XX kWh)
//   // Data located at bytes 12-15 (0-indexed)
//   // Note: Documentation suggests 4 bytes, but testing shows otherwise
//   const totalActiveKwh = bcdToInteger(bytes.subarray(12, 16).map(subtract33H)) / 100;
//   return {
//     totalActiveKwh: `${ totalActiveKwh } kWh`,
//   };
// }

/** Remaining credit: amount, credit level, relay status. */
const decodeReadCredit = (bytes: Buffer) => ({
  // Credit left: bytes 12-15 (4 bytes, BCD format, divided by 100 for kWh)
  kwhCreditAvailable: bcdToInteger(bytes.subarray(12, 16).map(subtract33H)) / 100,
  // Credit level: byte 16
  creditLevel: subtract33H(bytes[16]!),
  // Relay status: byte 17
  isOn: subtract33H(bytes[17]!) === 0,
  // Note: Alternative bit-flag form would be: !!(relayStatus & 0b00000001)
});

/** Automatic periodic report (DI: 0xC111). */
const decodeReadReport = (bytes: Buffer) => {
  // Rejected layout (year at byte 13 …): kept for archaeology
  // const freezeTimeYear = parseDateTimeByte(bytes[13]);
  // …

  // Extract freeze time: year (byte 17), month (byte 16), day (byte 15),
  // hour (byte 14), minute (byte 13)
  const freezeTimeYear = '20' + parseDateTimeByte(bytes[17]!);
  const freezeTimeMonth = parseDateTimeByte(bytes[16]!);
  const freezeTimeDay = parseDateTimeByte(bytes[15]!);
  const freezeTimeHour = parseDateTimeByte(bytes[14]!);
  const freezeTimeMinute = parseDateTimeByte(bytes[13]!);
  const freezeTime = `${ freezeTimeYear }-${ freezeTimeMonth }-${ freezeTimeDay } ${ freezeTimeHour }:${ freezeTimeMinute }`;

  // Source 1: consumption (bytes 18-21) / remaining purchase (bytes 22-25)
  const consumptionSource1 = reverseAndCombine(bytes.subarray(18, 22)) / 100;
  const purchaseRemainSource1 = processFloatFromBytes(bytes.subarray(22, 26));
  // Source 2: consumption (bytes 26-29) / remaining purchase (bytes 30-33)
  const consumptionSource2 = reverseAndCombine(bytes.subarray(26, 30)) / 100;
  const purchaseRemainSource2 = processFloatFromBytes(bytes.subarray(30, 34));
  // Interval demand: bytes 34-37
  const intervalDemand = reverseAndCombine(bytes.subarray(34, 38));
  // Voltage: bytes 38-39 (÷10 V)
  const voltage = reverseAndCombine(bytes.subarray(38, 40)) / 10;
  // Current: bytes 40-43 (÷1000 A)
  const current = reverseAndCombine(bytes.subarray(40, 44)) / 1000;

  // Meter status byte (byte 44): bit flags
  const meterStatus = subtract33H(bytes[44]!);

  return {
    freezeTime,
    consumptionSource1,
    purchaseRemainSource1,
    consumptionSource2,
    purchaseRemainSource2,
    intervalDemand,
    voltage,
    current,
    meterStatus: {
      relayOpen: !!(meterStatus & 0b00000001),
      batteryLow: !!(meterStatus & 0b00000010),
      magneticInterference: !!(meterStatus & 0b00000100),
      terminalCoverOpen: !!(meterStatus & 0b00001000),
      coverOpen: !!(meterStatus & 0b00010000),
      source2Activated: !!(meterStatus & 0b00100000),
      currentReverse: !!(meterStatus & 0b01000000),
      currentUnbalance: !!(meterStatus & 0b10000000),
    },
  };
};

/** Read meter date (DI: 0xC010). */
const decodeReadDate = (bytes: Buffer) => {
  // Date: weekday (byte 12), day (13), month (14), year (15, 2-digit)
  // Weekday is available at byte 12 (0 = Sunday) but is not returned
  // const weekday = subtract33H(bytes[12]);
  const day = parseDateTimeByte(bytes[13]!);
  const month = parseDateTimeByte(bytes[14]!);
  const year = '20' + parseDateTimeByte(bytes[15]!);
  return { day, month, year };
};

/** Read meter time (DI: 0xC011). */
const decodeReadTime = (bytes: Buffer) => {
  // Time: second (byte 12), minute (13), hour (14)
  const hour = bcdToString([ subtract33H(bytes[14]!) ]);
  const minute = bcdToString([ subtract33H(bytes[13]!) ]);
  const second = bcdToString([ subtract33H(bytes[12]!) ]);
  return { hour, minute, second };
};

// Processes Meter Running Status data (DI: 0xEFF5) — not wired yet
// function decodeMeterRunningStatus(bytes: Buffer) {
//   // Meter status bytes: bytes 12-13 (status_0 and status_1)
//   // Note: Documentation suggests reverse for LE, but testing uses as-is
//   const meterStatus0 = subtract33H(bytes[12]);
//   const meterStatus1 = subtract33H(bytes[13]);
//   // status_0: bit3 relay_open, bit5 gen_set, bit6 currency_type
//   // status_1: bit0 prepaid_type, bit1 credit_low, bit2 friendly_mode, bit3 credit_use_out
//   return {
//     relayOpen: !!(meterStatus0 & 0b00001000),
//     genSet: !!(meterStatus0 & 0b00100000),
//     currencyType: !!(meterStatus0 & 0b01000000),
//     prepaidType: !!(meterStatus1 & 0b00000001),
//     creditLow: !!(meterStatus1 & 0b00000010),
//     friendlyMode: !!(meterStatus1 & 0b00000100),
//     creditUseOut: !!(meterStatus1 & 0b00001000),
//   };
// }

const DATA_PROCESSOR_MAP = {
  // Meter voltage
  '0xB611': decodeReadVoltage('A'),
  '0xB612': decodeReadVoltage('B'),
  '0xB613': decodeReadVoltage('C'),

  // Meter power
  '0xB630': decodeReadPower('A'),
  '0xB631': decodeReadPower('B'),
  '0xB632': decodeReadPower('C'),

  // Meter current
  '0xB621': decodeReadCurrent('A'),
  '0xB622': decodeReadCurrent('B'),
  '0xB623': decodeReadCurrent('C'),

  '0xE421': decodeReadCredit,
  '0xC111': decodeReadReport,

  '0xC010': decodeReadDate,
  '0xC011': decodeReadTime,

  /** Total Active kWh Register data identifier (0x9010) */
  // '0x9010': processTotalActiveKwhRead,

  /** Meter Running Status data identifier (0xEFF5) */
  // '0xEFF5': decodeMeterRunningStatus,
} as const;

function hexArrayToNumber(buffer: Buffer): number {
  return buffer.readUIntBE(0, buffer.length);
}

function subtract33H(byte: number): number {
  return (byte - 0x33 + 256) % 256;
}

function reverseAndCombine(byteArray: Buffer): number {
  return byteArray.reduce(
    (acc, byte, index) => acc + (subtract33H(byte) << (index * 8)),
    0,
  );
}

function processFloatFromBytes(bytes: Buffer): number | null {
  if (bytes.length !== 4) return null;

  const processedBytes = bytes.map(subtract33H);
  const reversedBytes = processedBytes.slice().reverse();

  const floatBuffer = new ArrayBuffer(4);
  const floatView = new DataView(floatBuffer);
  reversedBytes.forEach((byte, index) => floatView.setUint8(index, byte));

  return floatView.getFloat32(0);
}

function bcdToInteger(bcdArray: Uint8Array): number {
  const resultStr = Array.from(bcdArray.slice().reverse())
    .map(byte => {
      const highNibble = (byte >> 4) & 0x0F;
      const lowNibble = byte & 0x0F;
      return `${ highNibble }${ lowNibble }`;
    })
    .join('');

  return parseInt(resultStr, 10);
}

function bcdToString(bcdArray: number[]): string {
  return bcdArray.map(bcd => ('0' + bcd.toString(16)).slice(-2)).join('');
}

function parseDateTimeByte(byte: number): string {
  return bcdToString([ subtract33H(byte) ]);
}
