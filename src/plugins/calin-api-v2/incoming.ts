/**
 * @fileoverview `calin-api-v2` incoming facet.
 *
 * PULL poll. `response.data` keys are camelCase.
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
} from '../../lib/device-message/types.js';
import { logger } from '../../log.js';
import { toSafeNumberOrNull } from '../_shared/to-safe-number-or-null.js';
import type { PullPlugin } from '../plugin.interface.js';
import type {
  CalinApiV2Client,
  CalinApiV2DataItem,
  CalinApiV2TaskDataResponse,
} from './lib/repo.js';
import { CalinApiV2Error } from './lib/repo.js';
import type { CalinApiV2Secrets } from './lib/secrets.js';

const TASK_PATH_MAP = {
  READ: '/API/RemoteMeterTask/GetReadingTask',
  CONTROL: '/API/RemoteMeterTask/GetControlTask',
  WRITE: '/API/RemoteMeterTask/GetSettingTask',
  TOKEN: '/API/RemoteMeterTask/GetTokenTask',
} as const;

type TaskType = keyof typeof TASK_PATH_MAP;

type TaskDataRow = NonNullable<
  NonNullable<CalinApiV2TaskDataResponse['result']>['data']
>[number];

type CreateCalinApiV2IncomingDeps = {
  readonly secrets: Pick<CalinApiV2Secrets, 'companyName'>;
  readonly client: CalinApiV2Client;
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

/**
 * Build the incoming facet for `calin-api-v2`.
 *
 * @param deps - Company name + HTTP client
 */
export function createCalinApiV2Incoming(
  deps: CreateCalinApiV2IncomingDeps,
): PullPlugin['incoming'] {
  const { secrets, client } = deps;

  const _parseResponseData = (
    result: TaskDataRow,
    taskType: TaskType,
  ): ParsedResponseSlice => {
    const { name, data } = result;
    switch (name.trim() as CalinApiV2DataItem) {
      // READ_CREDIT
      case 'Current Credit Balance': {
        return _createSuccessfulResponseData({
          kwhCreditAvailable: toSafeNumberOrNull(data),
        });
      }
      // READ_VOLTAGE
      case 'Phase-A Voltage': {
        return _createSuccessfulResponseData({
          voltage: toSafeNumberOrNull(data),
        });
      }
      // READ_POWER
      case 'Power': {
        return _createSuccessfulResponseData({
          power: toSafeNumberOrNull(data),
        });
      }
      // READ_CURRENT
      case 'Phase-A Current(A)': {
        return _createSuccessfulResponseData({
          current: toSafeNumberOrNull(data),
        });
      }
      // READ_POWER_LIMIT
      case 'Maximum power threshold': {
        return _createSuccessfulResponseData({
          powerLimit: toSafeNumberOrNull(data),
        });
      }
      // READ_VERSION
      case 'Meter Firmware Version': {
        return _createSuccessfulResponseData({
          version: data,
        });
      }
      // TURN_ON || TURN_OFF
      case 'Relay On/Off': {
        const accepted = data === 'Connected'
          ? { turnOnAccepted: true }
          : { turnOffAccepted: true };
        return _createSuccessfulResponseData(accepted);
      }
      // SET_DATE || READ_DATE
      case 'Clock(time)': {
        if (taskType === 'WRITE') {
          return _createSuccessfulResponseData({ dateAccepted: true });
        }

        const [ datePart ] = String(data).split(' ');
        const [ year, month, day ] = (datePart ?? '').split('-');
        return _createSuccessfulResponseData({
          year: toSafeNumberOrNull(year),
          month: toSafeNumberOrNull(month),
          day: toSafeNumberOrNull(day),
        });
      }
      // TOKEN DELIVERY
      case 'Token': {
        return _createSuccessfulResponseData({ tokenAccepted: true });
      }

      // OTHER COMMANDS
      default: {
        // We know it was successful, but have no additional data (?) so just respond with success.
        logger.warn({ module: 'calin-api-v2.incoming', result }, 'unknown command');
        return _createSuccessfulResponseData();
      }
    }
  };

  const fetchStatus = async (message: DeviceMessage): Promise<ParsedIncomingEvent | null> => {
    const { commandType, deliveryQueueId, device } = message;
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

    let res: CalinApiV2TaskDataResponse;

    try {
      res = await client.sendRequest<CalinApiV2TaskDataResponse>(TASK_PATH_MAP[taskType], {
        id: Number(deliveryQueueId),
        lang: 'en',
        company: secrets.companyName,
      });
    }
    catch (err) {
      // @TODO :: Revisit this
      logger.error({ module: 'calin-api-v2.incoming', err }, 'status check failed');
      const errMessage = err instanceof Error ? err.message : String(err);
      const errCode = err instanceof CalinApiV2Error ? err.code : undefined;
      return {
        ..._base,
        deliveryStatus: 'DELIVERY_FAILED',
        failureContext: {
          reason: 'Could not check task status because ' + errMessage,
          errorCode: errCode,
        },
      };
    }

    const _result = res?.result?.data?.[0];

    if (!_result) {
      logger.info({
        module: 'calin-api-v2.incoming',
        reason: res?.reason,
      }, 'no result when fetching status');
      return {
        ..._base,
        deliveryStatus: 'DELIVERY_FAILED',
        failureContext: {
          reason: res?.reason ?? 'CALIN API-V2 gave no status or data for this task',
        },
      };
    }

    // Processing
    if (_result.status === 0) return null;

    // Success
    if (_result.status === 1) {
      return {
        ..._base,
        deliveryStatus: 'DELIVERY_SUCCESSFUL',
        ..._parseResponseData(_result, taskType),
      };
    }

    // Failed / Rejected
    if (_result.status >= 2) {
      const reason = _result.status === 3
        ? 'The token was rejected, possibly already delivered'
        : res.reason !== 'success'
          ? res.reason
          : 'Delivery was successful but execution of the command failed';
      return {
        ..._base,
        deliveryStatus: 'DELIVERY_SUCCESSFUL',
        response: { status: 'EXECUTION_FAILURE' },
        failureContext: {
          reason,
          // If the token was rejected, there's no use for retries
          skipRetry: _result.status === 3,
        },
      };
    }

    logger.warn({ module: 'calin-api-v2.incoming', result: _result }, 'unexpected status');
    return null;
  };

  return { fetchStatus };
}
