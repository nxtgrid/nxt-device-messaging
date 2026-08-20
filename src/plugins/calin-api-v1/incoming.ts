/**
 * @fileoverview `calin-api-v1` incoming facet (Unit 7.4).
 *
 * Port of legacy `adapters/calin-api-v1/_incoming.service.ts` (PULL poll).
 * `response.data` keys are camelCase (deliberate vs legacy snake_case).
 */

import {
  isControlCommand,
  isReadCommand,
  isTokenCommand,
  isWriteCommand,
} from '../../lib/device-message/command-types.js';
import type {
  DeviceMessage,
  FailureContext,
  MessageResponseStatus,
  ParsedIncomingEvent,
  PhaseEnum,
} from '../../lib/device-message/types.js';
import { logger } from '../../log.js';
import { toSafeNumberOrNull } from '../_shared/to-safe-number-or-null.js';
import type { PullPlugin } from '../plugin.interface.js';
import type {
  CalinApiV1Client,
  CalinApiV1CommResponse,
} from './lib/repo.js';
import { CalinApiV1Error } from './lib/repo.js';
import type { CalinApiV1Secrets } from './lib/secrets.js';

const TASK_PATH_MAP = {
  READ: '/COMM_RemoteReadingTask',
  CONTROL: '/COMM_RemoteControlTask',
  WRITE: '/COMM_RemoteWriteTask',
  TOKEN: '/COMM_RemoteTokenTask',
} as const;

// Map DataItem to phase (for three-phase responses)
const dataItemToPhase: Record<string, PhaseEnum> = {
  'VoltageA': 'A', 'VoltageB': 'B', 'VoltageC': 'C',
  // 'PowerA': 'A', 'PowerB': 'B', 'PowerC': 'C',
  'CurrentA': 'A', 'CurrentB': 'B', 'CurrentC': 'C',
};

type CreateCalinApiV1IncomingDeps = {
  readonly secrets: Pick<CalinApiV1Secrets, 'companyName' | 'adminUsername' | 'adminPassword'>;
  readonly client: CalinApiV1Client;
};

type ParsedResponseSlice = {
  response: { status: MessageResponseStatus; data?: Record<string, unknown>; };
  failureContext?: FailureContext;
};

const _createSuccessfulResponseData = (data?: Record<string, unknown>): ParsedResponseSlice => ({
  response: {
    status: 'EXECUTION_SUCCESS',
    ...(data !== undefined && { data }),
  },
});

const _createFailedResponseData = (reason: string): ParsedResponseSlice => ({
  response: { status: 'EXECUTION_FAILURE' },
  failureContext: { reason },
});

/**
 * Build the incoming facet for `calin-api-v1`.
 *
 * @param deps - Admin COMM credentials + HTTP client
 */
export function createCalinApiV1Incoming(
  deps: CreateCalinApiV1IncomingDeps,
): PullPlugin['incoming'] {
  const { secrets, client } = deps;

  const commApiData = {
    CompanyName: secrets.companyName,
    UserName: secrets.adminUsername,
    Password: secrets.adminPassword,
  };

  const _parseResponseData = (
    fullResult: NonNullable<CalinApiV1CommResponse['Result']>,
    requestedPhase?: PhaseEnum,
  ): ParsedResponseSlice => {
    const { DataItem, Data } = fullResult;
    const responsePhase = dataItemToPhase[DataItem] ?? requestedPhase;

    switch (DataItem) {
      // READ_CREDIT
      case 'Current Credit Register': {
        if (Data.length === 0) {
          return _createFailedResponseData('CALIN API-V1 responded with an empty value');
        }
        const [ currentCredit, meterOnOff ] = Data.split(',');
        const kwhCreditAvailable = toSafeNumberOrNull(currentCredit);
        if (kwhCreditAvailable === null) {
          return _createFailedResponseData(`CALIN API-V1 responded with "${ Data }" while we were expecting kWh and relay status`);
        }
        return _createSuccessfulResponseData({ kwhCreditAvailable, isOn: meterOnOff === 'ON' });
      }

      // READ_VOLTAGE
      case 'Voltage':
      case 'VoltageA':
      case 'VoltageB':
      case 'VoltageC': {
        const [ _voltage ] = Data.split(' ');
        const voltage = toSafeNumberOrNull(_voltage);
        if (voltage === null) {
          return _createFailedResponseData(`CALIN API-V1 responded with "${ Data }" while we were expecting a voltage number`);
        }
        return _createSuccessfulResponseData({
          voltage,
          ...(responsePhase && { phase: responsePhase }),
        });
      }

      // READ_POWER
      case 'Power':
      // case 'PowerA':
      // case 'PowerB':
      // case 'PowerC':
      {
        const [ power ] = Data.split(' ');
        return _createSuccessfulResponseData({
          power: toSafeNumberOrNull(power),
          ...(responsePhase && { phase: responsePhase }),
        });
      }

      // READ_CURRENT
      case 'Current':
      case 'CurrentA':
      case 'CurrentB':
      case 'CurrentC': {
        const [ current ] = Data.split(' ');
        return _createSuccessfulResponseData({
          current: toSafeNumberOrNull(current),
          ...(responsePhase && { phase: responsePhase }),
        });
      }

      // READ_POWER_LIMIT
      case 'Maximum power threshold': {
        const [ powerLimit ] = Data.split(' ');
        return _createSuccessfulResponseData({ powerLimit: toSafeNumberOrNull(powerLimit) });
      }

      // READ_VERSION
      case 'Version': {
        return _createSuccessfulResponseData({ version: Data });
      }

      // SET_DATE || READ_DATE
      case 'Date': {
        // Write
        if (!Data.length) return _createSuccessfulResponseData({ dateAccepted: true });

        // Read
        const [ _date, _weekday ] = Data.split(' ');
        const [ _year, _month, _day ] = _date.split('-');
        return _createSuccessfulResponseData({
          year: toSafeNumberOrNull('20' + _year),
          month: toSafeNumberOrNull(_month),
          day: toSafeNumberOrNull(_day),
          // weekday: toSafeNumberOrNull(_weekday),
        });
      }

      // TURN_ON
      case 'Switch On': {
        return _createSuccessfulResponseData({ turnOnAccepted: true });
      }
      // TURN_OFF
      case 'Switch Off': {
        return _createSuccessfulResponseData({ turnOffAccepted: true });
      }
      // TOKEN DELIVERY
      case 'Token': {
        return _createSuccessfulResponseData({ tokenAccepted: true });
      }

      // OTHER COMMANDS
      default: {
        // We know it was successful, but have no additional data (?) so just respond with success.
        logger.warn({ module: 'calin-api-v1.incoming', fullResult }, 'unknown command');
        return _createSuccessfulResponseData();
      }
    }
  };

  const fetchStatus = async (message: DeviceMessage): Promise<ParsedIncomingEvent | null> => {
    const { commandType, deliveryQueueId, device, phase, id, correlationId } = message;
    const _base = {
      deliveryQueueId,
      commandType,
      device,
    };

    const taskType = isReadCommand(commandType) ? 'READ'
      : isControlCommand(commandType) ? 'CONTROL'
        : isWriteCommand(commandType) ? 'WRITE'
          : isTokenCommand(commandType) ? 'TOKEN'
            : null;
    if (!taskType) return null;

    let res: CalinApiV1CommResponse;

    try {
      res = await client.sendRequest<CalinApiV1CommResponse>(TASK_PATH_MAP[taskType], {
        ...commApiData,
        TaskNo: deliveryQueueId,
      });
    }
    catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      const errCode = err instanceof CalinApiV1Error ? err.code ?? undefined : undefined;
      return {
        ..._base,
        deliveryStatus: 'DELIVERY_FAILED',
        failureContext: {
          reason: 'Could not check task status because ' + errMessage,
          errorCode: errCode,
        },
      };
    }

    const _result = res?.Result;

    if (!_result) {
      if (res.ResultCode === '99') {
        logger.info({
          module: 'calin-api-v1.incoming',
          messageId: id,
          correlationId,
          commandType,
        }, 'token rejected');
        return {
          ..._base,
          deliveryStatus: 'DELIVERY_FAILED',
          failureContext: {
            reason: 'The token was rejected, possibly already delivered.',
            errorCode: 99,
            skipRetry: true,
          },
        };
      }
      else {
        logger.info({
          module: 'calin-api-v1.incoming',
          resultCode: res.ResultCode,
          reason: res.Reason,
        }, 'no result when fetching status');
        return {
          ..._base,
          deliveryStatus: 'DELIVERY_FAILED',
          failureContext: {
            reason: res?.Reason ?? 'CALIN API V1 gave no status or data for this task',
          },
        };
      }
    }

    if (!_result.Status || _result.Status === 'unknown') return null;

    if (_result.Status === 'False') {
      return {
        ..._base,
        deliveryStatus: 'DELIVERY_SUCCESSFUL',
        response: { status: 'EXECUTION_FAILURE' },
        failureContext: {
          reason: res.Reason !== 'OK'
            ? res.Reason
            : 'Delivery was successful but execution of the command failed',
        },
      };
    }

    if (_result.Status !== 'True') {
      logger.warn({ module: 'calin-api-v1.incoming', result: _result }, 'unexpected status');
      return null;
    }

    return {
      ..._base,
      deliveryStatus: 'DELIVERY_SUCCESSFUL',
      ..._parseResponseData(_result, phase),
    };
  };

  return { fetchStatus };
}
