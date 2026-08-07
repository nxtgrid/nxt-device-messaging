/**
 * @fileoverview `calin-api-v2` outgoing facet (Unit 9.3).
 *
 * Port of legacy `adapters/calin-api-v2/_outgoing.service.ts`. Creates remote
 * meter tasks (read / control / write / token delivery) via
 * {@link CalinApiV2Client}.
 */

import { isTokenCommand } from '../../lib/device-message/command-types.js';
import type {
  DeviceMessage,
  FailureContext,
  SetDatePayload,
} from '../../lib/device-message/types.js';
import type { DeviceMessagingPlugin } from '../plugin.interface.js';
import type {
  CalinApiV2Client,
  CalinApiV2CreateTaskResponse,
} from './lib/repo.js';
import { CalinApiV2Error } from './lib/repo.js';
import type { CalinApiV2Secrets } from './lib/secrets.js';

// @NOTE :: Calling '/api/dlms/readDlmsTree' with { "Company": "NXT", "lang": "en", "version": "1.1" }
// will render a list of all available commands with their protocolIds
const CalinApiV2ReadMap = {
  READ_CREDIT: 39,
  READ_VOLTAGE: 5,
  READ_POWER: 11,
  READ_CURRENT: 8,
  READ_POWER_LIMIT: 46,
  READ_VERSION: 45,
  READ_DATE: 29,
  // READ_POWER_DOWN_COUNT: 47,
  // READ_TERMINAL_COVER_LAST_OPENED: 42,
  // READ_SPECIAL_STATUS (_IDENTIFIER?): 43,
  // READ_RELAY_STATUS: 37 // CALIN V2 only
} as const;

const CalinApiV2ControlMap = {
  TURN_ON: 20000,
  TURN_OFF: 20001,
} as const;

const CalinApiV2WriteMap = {
  SET_DATE: 10000,
  // SET_TIME: 'Time',
} as const;

const CALIN_API_V2_TOKEN_DELIVERY_PROTOCOL_ID = 30000;

type ImplementedMessageReadTypes = keyof typeof CalinApiV2ReadMap;
type ImplementedMessageControlTypes = keyof typeof CalinApiV2ControlMap;
type ImplementedMessageWriteTypes = keyof typeof CalinApiV2WriteMap;

type CalinApiV2ReadTask = (typeof CalinApiV2ReadMap)[ImplementedMessageReadTypes];
type CalinApiV2ControlTask = (typeof CalinApiV2ControlMap)[ImplementedMessageControlTypes];
type CalinApiV2WriteTask = (typeof CalinApiV2WriteMap)[ImplementedMessageWriteTypes];

/** Type guard: checks at runtime AND narrows the type for TypeScript. */
const isCalinApiV2ReadCommand = (
  commandType: string,
): commandType is ImplementedMessageReadTypes => Object.hasOwn(CalinApiV2ReadMap, commandType);
const isCalinApiV2ControlCommand = (
  commandType: string,
): commandType is ImplementedMessageControlTypes => Object.hasOwn(CalinApiV2ControlMap, commandType);
const isCalinApiV2WriteCommand = (
  commandType: string,
): commandType is ImplementedMessageWriteTypes => Object.hasOwn(CalinApiV2WriteMap, commandType);

type CreateCalinApiV2OutgoingDeps = {
  readonly secrets: Pick<CalinApiV2Secrets, 'companyName' | 'customerId'>;
  readonly client: CalinApiV2Client;
};

/**
 * Build the outgoing facet for `calin-api-v2`.
 *
 * @param deps - Company / customer id + HTTP client
 */
export function createCalinApiV2Outgoing(
  deps: CreateCalinApiV2OutgoingDeps,
): DeviceMessagingPlugin['outgoing'] {
  const { secrets, client } = deps;

  /** Format a calendar date for CALIN V2 `SET_DATE` (`YYYY-MM-DD HH:mm:ss`). */
  const _formatDate = ({ year, month, day }: { year: number; month: number; day: number }): string => {
    if (
      !Number.isSafeInteger(year)
      || !Number.isSafeInteger(month)
      || !Number.isSafeInteger(day)
    ) {
      throw new CalinApiV2Error('Invalid payload for setting date', { skipRetry: true });
    }
    // Normalize 2-digit years to 20xx so we never emit "0024-..." for year=24.
    const fullYear = year < 100 ? 2000 + year : year;
    const utc = new Date(Date.UTC(fullYear, month - 1, day));
    if (
      utc.getUTCFullYear() !== fullYear
      || utc.getUTCMonth() !== month - 1
      || utc.getUTCDate() !== day
    ) {
      throw new CalinApiV2Error('Invalid payload for setting date', { skipRetry: true });
    }
    const yyyy = String(fullYear).padStart(4, '0');
    const mm = String(month).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    // The API expects "YYYY-MM-DD HH:mm:ss"; we only set the date so time is 00:00:00
    return `${ yyyy }-${ mm }-${ dd } 00:00:00`;
  };

  /**
   * Create a remote meter task and return its vendor id.
   * Shared by read / control / write / token-delivery paths.
   */
  const _createTask = async (opts: {
    readonly path: string;
    readonly protocolId:
      | CalinApiV2ReadTask
      | CalinApiV2ControlTask
      | CalinApiV2WriteTask
      | typeof CALIN_API_V2_TOKEN_DELIVERY_PROTOCOL_ID;
    readonly meterId: string;
    readonly data?: string;
  }): Promise<string> => {
    const res = await client.sendRequest<CalinApiV2CreateTaskResponse>(
      opts.path,
      [ {
        meterId: opts.meterId,
        protocolId: opts.protocolId,
        ...(opts.data !== undefined ? { data: opts.data } : {}),
        customerId: secrets.customerId,
        company: secrets.companyName,
      } ],
    );

    const taskId = res.result?.[0]?.id;
    if (!taskId) {
      throw new CalinApiV2Error(
        `CALIN API-V2 did not schedule task because: ${ res.reason ?? 'unknown' }`,
      );
    }
    return taskId;
  };

  const _requestRead = (
    protocolId: CalinApiV2ReadTask,
    meterId: string,
  ): Promise<string> => _createTask({
    path: '/API/RemoteMeterTask/CreateReadingTask',
    protocolId,
    meterId,
  });

  const _requestControl = (
    protocolId: CalinApiV2ControlTask,
    meterId: string,
  ): Promise<string> => _createTask({
    path: '/API/RemoteMeterTask/CreateControlTask',
    protocolId,
    meterId,
  });

  const _requestWrite = (
    protocolId: CalinApiV2WriteTask,
    data: string,
    meterId: string,
  ): Promise<string> => _createTask({
    path: '/API/RemoteMeterTask/CreateSettingTask',
    protocolId,
    meterId,
    data,
  });

  const _requestTokenDelivery = (
    token: string,
    meterId: string,
  ): Promise<string> => _createTask({
    path: '/API/RemoteMeterTask/CreateTokenTask',
    protocolId: CALIN_API_V2_TOKEN_DELIVERY_PROTOCOL_ID,
    meterId,
    data: token,
  });

  const _parsePayload = (commandType: DeviceMessage['commandType'], payload: NonNullable<DeviceMessage['requestData']>['payload']): string => {
    if (!payload) {
      throw new CalinApiV2Error('Can\'t perform a write request without a payload', {
        skipRetry: true,
      });
    }
    switch (commandType) {
      case 'SET_DATE':
        return _formatDate(payload as SetDatePayload);
      default:
        throw new CalinApiV2Error('Payload parser not implemented', { skipRetry: true });
    }
  };

  const sendOne = async (message: DeviceMessage): Promise<string> => {
    const { externalReference } = message.device;

    if (isCalinApiV2ReadCommand(message.commandType)) {
      return _requestRead(CalinApiV2ReadMap[message.commandType], externalReference);
    }

    if (isCalinApiV2ControlCommand(message.commandType)) {
      return _requestControl(CalinApiV2ControlMap[message.commandType], externalReference);
    }

    if (isCalinApiV2WriteCommand(message.commandType)) {
      const parsedPayload = _parsePayload(message.commandType, message.requestData?.payload);
      return _requestWrite(CalinApiV2WriteMap[message.commandType], parsedPayload, externalReference);
    }

    if (isTokenCommand(message.commandType)) {
      const token = message.requestData?.token;
      // Enqueue Zod leaves `requestData.token` optional (incl. ''); mint paths
      // are expected to set it, but Redis/replay can still arrive without one.
      if (typeof token !== 'string' || token.trim() === '') {
        throw new CalinApiV2Error('Can\'t perform a token delivery without a token', {
          skipRetry: true,
        });
      }
      return _requestTokenDelivery(token, externalReference);
    }

    throw new CalinApiV2Error('Not implemented', { skipRetry: true });
  };

  const parseError = (err: unknown): FailureContext => {
    if (err instanceof CalinApiV2Error) {
      return {
        reason: err.message,
        errorCode: err.code,
        skipRetry: err.skipRetry,
      };
    }
    if (err instanceof Error) {
      console.error('[CALIN V2 API] Parsing a non-custom error', err);
      return { reason: err.message };
    }
    console.error('[CALIN V2 API] Parsing a non-custom error', err);
    return { reason: String(err) };
  };

  return { sendOne, parseError };
}
