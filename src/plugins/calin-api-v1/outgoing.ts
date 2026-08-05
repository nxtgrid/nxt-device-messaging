/**
 * @fileoverview `calin-api-v1` outgoing facet (Unit 7.3).
 *
 * Port of legacy `adapters/calin-api-v1/_outgoing.service.ts`. Creates COMM
 * tasks (read / control / write / token delivery) via {@link CalinApiV1Client}.
 */

import {
  isPhaseSpecificReadCommand,
  isTokenCommand,
} from '../../lib/device-message/command-types.js';
import type {
  DeviceMessage,
  FailureContext,
  PhaseEnum,
  SetDatePayload,
} from '../../lib/device-message/types.js';
import { toSafeNumberOrNull } from '../_shared/to-safe-number-or-null.js';
import type { DeviceMessagingPlugin } from '../plugin.interface.js';
import type {
  CalinApiV1Client,
  CalinApiV1CommResponse,
} from './lib/repo.js';
import { CalinApiV1Error } from './lib/repo.js';
import type { CalinApiV1Secrets } from './lib/secrets.js';

const CalinApiV1ReadMap = {
  READ_CREDIT: 'Current Credit Register',
  READ_VOLTAGE: 'Voltage',
  READ_POWER: 'Power',
  READ_CURRENT: 'Current',
  READ_POWER_LIMIT: 'Maximum power threshold',
  READ_VERSION: 'Version',
  READ_DATE: 'Date',
  // READ_TIME: 'Time',
  // READ_POWER_DOWN_COUNT: 'The number of power down',
  // READ_SPECIAL_STATUS (_IDENTIFIER?): 'Special status identifier',
} as const;

type CalinPhaseReadEnum =
  | 'VoltageA' | 'VoltageB' | 'VoltageC'
  /* | 'PowerA' | 'PowerB' | 'PowerC' */
  | 'CurrentA' | 'CurrentB' | 'CurrentC';

// Phase-specific read commands for CALIN API V1
const CalinApiV1PhaseReadMap = {
  READ_VOLTAGE: { A: 'VoltageA', B: 'VoltageB', C: 'VoltageC' },
  // READ_POWER: { A: 'PowerA', B: 'PowerB', C: 'PowerC' },
  READ_CURRENT: { A: 'CurrentA', B: 'CurrentB', C: 'CurrentC' },
} as const satisfies {
  readonly READ_VOLTAGE: Record<PhaseEnum, CalinPhaseReadEnum>;
  readonly READ_CURRENT: Record<PhaseEnum, CalinPhaseReadEnum>;
};

const CalinApiV1ControlMap = {
  TURN_ON: 'Switch On',
  TURN_OFF: 'Switch Off',
} as const;

const CalinApiV1WriteMap = {
  SET_DATE: 'Date',
  // SET_TIME: 'Time',
} as const;

type ImplementedMessageReadTypes = keyof typeof CalinApiV1ReadMap;
type ImplementedMessageControlTypes = keyof typeof CalinApiV1ControlMap;
type ImplementedMessageWriteTypes = keyof typeof CalinApiV1WriteMap;

type CalinApiV1ReadTask = | (typeof CalinApiV1ReadMap)[ImplementedMessageReadTypes] | CalinPhaseReadEnum;
type CalinApiV1ControlTask = (typeof CalinApiV1ControlMap)[ImplementedMessageControlTypes];
type CalinApiV1WriteTask = (typeof CalinApiV1WriteMap)[ImplementedMessageWriteTypes];

/** Type guard: checks at runtime AND narrows the type for TypeScript. */
const isCalinApiV1ReadCommand = (commandType: string): commandType is ImplementedMessageReadTypes => commandType in CalinApiV1ReadMap;
const isCalinApiV1ControlCommand = (commandType: string): commandType is ImplementedMessageControlTypes => commandType in CalinApiV1ControlMap;
const isCalinApiV1WriteCommand = (commandType: string): commandType is ImplementedMessageWriteTypes => commandType in CalinApiV1WriteMap;

type CreateCalinApiV1OutgoingDeps = {
  readonly secrets: Pick<CalinApiV1Secrets, 'companyName' | 'adminUsername' | 'adminPassword'>;
  readonly client: CalinApiV1Client;
};

/**
 * Build the outgoing facet for `calin-api-v1`.
 *
 * @param deps - Admin COMM credentials + HTTP client
 */
export function createCalinApiV1Outgoing(
  deps: CreateCalinApiV1OutgoingDeps,
): DeviceMessagingPlugin['outgoing'] {
  const { secrets, client } = deps;

  const commApiData = {
    CompanyName: secrets.companyName,
    UserName: secrets.adminUsername,
    Password: secrets.adminPassword,
  };

  /** Format a calendar date for CALIN `SET_DATE` (`yymmddww`, UTC weekday). */
  const _formatDate = ({ year, month, day }: { year: number; month: number; day: number }): string => {
    if (
      !(typeof year === 'number')
      || !(typeof month === 'number')
      || !(typeof day === 'number')
    ) {
      throw new Error('Invalid payload for setting date');
    }
    // Normalize 2-digit years to 20xx. The Date constructor would otherwise
    // treat values 0-99 as 1900-1999, silently producing the wrong weekday.
    const fullYear = year < 100 ? 2000 + year : year;
    // Use UTC explicitly: the DTO carries grid-local calendar values and the
    // server typically runs in UTC, so we treat year/month/day as a literal
    // calendar date rather than a server-local timestamp.
    const weekday = new Date(Date.UTC(fullYear, month - 1, day)).getUTCDay();
    const yy = String(fullYear % 100).padStart(2, '0');
    const mm = String(month).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    const ww = String(weekday).padStart(2, '0');
    return `${ yy }${ mm }${ dd }${ ww }`;
  };

  const _getReadDataItem = (commandType: ImplementedMessageReadTypes, phase?: PhaseEnum): CalinApiV1ReadTask => {
    if (phase !== undefined && isPhaseSpecificReadCommand(commandType)) {
      return CalinApiV1PhaseReadMap[commandType][phase];
    }
    return CalinApiV1ReadMap[commandType];
  };

  const _requestRead = async (taskType: CalinApiV1ReadTask, meterNo: string): Promise<string> => {
    const res = await client.sendRequest<CalinApiV1CommResponse>(
      '/COMM_RemoteReading',
      {
        ...commApiData,
        MeterNo: meterNo,
        DataItem: taskType,
      },
    );

    const taskId = res.Result?.TaskNo;

    if (!taskId) {
      const errorMessage = `CALIN API-V1 did not schedule task because: ${ res.Reason ?? 'unknown' }`;
      throw new CalinApiV1Error(errorMessage, toSafeNumberOrNull(res.ResultCode));
    }

    return taskId;
  };

  const _requestControl = async (taskType: CalinApiV1ControlTask, meterNo: string): Promise<string> => {
    const res = await client.sendRequest<CalinApiV1CommResponse>(
      '/COMM_RemoteControl',
      {
        ...commApiData,
        MeterNo: meterNo,
        DataItem: taskType,
      },
    );

    const taskId = res.Result?.TaskNo;

    if (!taskId) {
      const errorMessage = `CALIN API V1 did not schedule task because: ${ res.Reason ?? 'unknown' }`;
      throw new CalinApiV1Error(errorMessage, toSafeNumberOrNull(res.ResultCode));
    }

    return taskId;
  };

  const _requestWrite = async (taskType: CalinApiV1WriteTask, data: string, meterNo: string): Promise<string> => {
    const res = await client.sendRequest<CalinApiV1CommResponse>(
      '/COMM_RemoteWrite',
      {
        ...commApiData,
        MeterNo: meterNo,
        DataItem: taskType,
        Data: data,
      },
    );

    const taskId = res.Result?.TaskNo;

    if (!taskId) {
      const errorMessage = `CALIN API V1 did not schedule task because: ${ res.Reason ?? 'unknown' }`;
      throw new CalinApiV1Error(errorMessage, toSafeNumberOrNull(res.ResultCode));
    }

    return taskId;
  };

  const _requestTokenDelivery = async (token: string, meterNo: string): Promise<string> => {
    const res = await client.sendRequest<CalinApiV1CommResponse>(
      '/COMM_RemoteToken',
      {
        ...commApiData,
        MeterNo: meterNo,
        Token: token,
      },
    );

    const taskId = res.Result?.TaskNo;
    if (!taskId) {
      const errorMessage = res.ResultCode === '99'
        ? `Token ${ token } was immediately rejected for meter ${ meterNo }, possibly already delivered`
        : `CALIN API V1 did not schedule task because: ${ res.Reason ?? 'unknown' }`;
      throw new CalinApiV1Error(errorMessage, toSafeNumberOrNull(res.ResultCode));
    }

    return taskId;
  };

  const _parsePayload = (
    commandType: DeviceMessage['commandType'],
    payload: NonNullable<DeviceMessage['requestData']>['payload'],
  ): string => {
    if (!payload) {
      throw new Error('Can\'t perform a write request without a payload');
    }
    switch (commandType) {
      case 'SET_DATE':
        return _formatDate(payload as SetDatePayload);
      default:
        throw new Error('Payload parser not implemented');
    }
  };

  const sendOne = async (message: DeviceMessage): Promise<string> => {
    const { externalReference } = message.device;

    if (isCalinApiV1ReadCommand(message.commandType)) {
      const dataItem = _getReadDataItem(message.commandType, message.phase);
      return _requestRead(dataItem, externalReference);
    }

    if (isCalinApiV1ControlCommand(message.commandType)) {
      return _requestControl(CalinApiV1ControlMap[message.commandType], externalReference);
    }

    if (isCalinApiV1WriteCommand(message.commandType)) {
      const parsedPayload = _parsePayload(message.commandType, message.requestData?.payload);
      return _requestWrite(CalinApiV1WriteMap[message.commandType], parsedPayload, externalReference);
    }

    if (isTokenCommand(message.commandType)) {
      const token = message.requestData?.token;
      // Enqueue Zod leaves `requestData.token` optional (incl. ''); mint paths
      // are expected to set it, but Redis/replay can still arrive without one.
      if (typeof token !== 'string' || token.trim() === '') {
        throw new Error('Can\'t perform a token delivery without a token');
      }
      return _requestTokenDelivery(token, externalReference);
    }

    throw new Error('Not implemented');
  };

  const parseError = (err: unknown): FailureContext => {
    if (err instanceof CalinApiV1Error) {
      return {
        reason: err.message,
        errorCode: err.code ?? undefined,
        // For error code 99 (rejected tokens) we can fail immediately
        skipRetry: err.code === 99,
      };
    }
    if (err instanceof Error) {
      return { reason: err.message };
    }
    return { reason: String(err) };
  };

  return { sendOne, parseError };
}
