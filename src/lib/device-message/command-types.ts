/**
 * @fileoverview Service-owned command / token-type vocabulary.
 *
 * This repo owns the closed set (ADR-003 §4).
 *
 * - {@link COMMAND_TYPES} — everything the app knows (incl. unsolicited)
 * - {@link ENQUEUEABLE_COMMAND_TYPES} — valid on `POST /message/enqueue`
 * - {@link GENERATE_TOKEN_TYPES} — valid on `POST /token/generate` (`type` field)
 */

/** Phase-specific reads (need `phase` on create). */
export const PHASE_SPECIFIC_READ_COMMAND_TYPES = [
  'READ_VOLTAGE',
  'READ_CURRENT',
] as const;

/** Outbound read commands. */
export const READ_COMMAND_TYPES = [
  ...PHASE_SPECIFIC_READ_COMMAND_TYPES,
  'READ_POWER',
  'READ_POWER_LIMIT',
  'READ_CREDIT',
  'READ_VERSION',
  'READ_DATE',
  'READ_TIME',
] as const;

/** Relay / breaker control. */
export const CONTROL_COMMAND_TYPES = [ 'TURN_ON', 'TURN_OFF' ] as const;

/** Clock write commands. */
export const WRITE_COMMAND_TYPES = [ 'SET_DATE', 'SET_TIME' ] as const;

/**
 * Token commands that mint via the token API, then deliver.
 * Subset of {@link TOKEN_COMMAND_TYPES} used by `POST /token/generate`.
 *
 * `TOP_UP_KWH` is kWh credit (estate DB still uses `TOP_UP` — map at cutover).
 * A future currency top-up would be a new value (e.g. `TOP_UP_CURRENCY`), not a rename.
 */
export const GENERATE_TOKEN_TYPES = [
  'CLEAR_CREDIT',
  'CLEAR_TAMPER',
  'SET_POWER_LIMIT',
  'TOP_UP_KWH',
] as const;

/**
 * Token-related *message* commands (enqueue).
 * Includes `DELIVER_PREEXISTING_TOKEN` — already-minted delivery.
 */
export const TOKEN_COMMAND_TYPES = [
  ...GENERATE_TOKEN_TYPES,
  'DELIVER_PREEXISTING_TOKEN',
] as const;

/**
 * Device-originated / ingress-only. Not valid on enqueue
 * ({@link ENQUEUEABLE_COMMAND_TYPES}).
 */
export const UNSOLICITED_COMMAND_TYPES = [ 'READ_REPORT', 'JOIN_NETWORK' ] as const;

/** Full app vocabulary (enqueueable + unsolicited). */
export const COMMAND_TYPES = [
  ...READ_COMMAND_TYPES,
  ...CONTROL_COMMAND_TYPES,
  ...WRITE_COMMAND_TYPES,
  ...TOKEN_COMMAND_TYPES,
  ...UNSOLICITED_COMMAND_TYPES,
] as const;

/** Types accepted by `POST /message/enqueue` and stub `supportedCommandTypes`. */
export const ENQUEUEABLE_COMMAND_TYPES = [
  ...READ_COMMAND_TYPES,
  ...CONTROL_COMMAND_TYPES,
  ...WRITE_COMMAND_TYPES,
  ...TOKEN_COMMAND_TYPES,
] as const;

export type PhaseSpecificReadCommandType = (typeof PHASE_SPECIFIC_READ_COMMAND_TYPES)[number];
export type ReadCommandType = (typeof READ_COMMAND_TYPES)[number];
export type ControlCommandType = (typeof CONTROL_COMMAND_TYPES)[number];
export type WriteCommandType = (typeof WRITE_COMMAND_TYPES)[number];
export type GenerateTokenType = (typeof GENERATE_TOKEN_TYPES)[number];
export type TokenCommandType = (typeof TOKEN_COMMAND_TYPES)[number];
export type UnsolicitedCommandType = (typeof UNSOLICITED_COMMAND_TYPES)[number];
export type CommandType = (typeof COMMAND_TYPES)[number];
export type EnqueueableCommandType = (typeof ENQUEUEABLE_COMMAND_TYPES)[number];

/**
 * Narrow a non-empty `as const` array for `z.enum` (needs `[T, ...T[]]`).
 */
export function asZodEnum<T extends string>(
  values: readonly [ T, ...T[] ],
): [ T, ...T[] ] {
  return values as [ T, ...T[] ];
}

type CommandTypeGuard<T extends readonly CommandType[]> = (
  commandType: string,
) => commandType is T[number];

const isTypeIn = <const T extends readonly CommandType[]>(group: T): CommandTypeGuard<T> =>
  (commandType: string): commandType is T[number] =>
    (group as readonly string[]).includes(commandType);

export const isPhaseSpecificReadCommand = isTypeIn(PHASE_SPECIFIC_READ_COMMAND_TYPES);
export const isReadCommand = isTypeIn(READ_COMMAND_TYPES);
export const isControlCommand = isTypeIn(CONTROL_COMMAND_TYPES);
export const isWriteCommand = isTypeIn(WRITE_COMMAND_TYPES);
export const isTokenCommand = isTypeIn(TOKEN_COMMAND_TYPES);
export const isGenerateTokenType = isTypeIn(GENERATE_TOKEN_TYPES);
export const isUnsolicitedCommand = isTypeIn(UNSOLICITED_COMMAND_TYPES);
export const isEnqueueableCommand = isTypeIn(ENQUEUEABLE_COMMAND_TYPES);
export const isCommandType = isTypeIn(COMMAND_TYPES);
