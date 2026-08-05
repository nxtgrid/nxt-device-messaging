/**
 * @fileoverview `calin-api-v1` token facet (Unit 7.5).
 *
 * Port of legacy `adapters/calin-api-v1/_token.service.ts`.
 * Wire type is `TOP_UP_KWH` (not legacy `TOP_UP`).
 */

import type { GenerateTokenInput } from '../../lib/device-message/types.js';
import type { DeviceMessagingPlugin } from '../plugin.interface.js';
import type {
  CalinApiV1Client,
  CalinApiV1MaintenanceResponse,
  CalinApiV1PosResponse,
} from './lib/repo.js';
import type { CalinApiV1Secrets } from './lib/secrets.js';

type CreateCalinApiV1TokenDeps = {
  readonly secrets: Pick<CalinApiV1Secrets, 'companyName' | 'posUsername' | 'posPassword' | 'maintenanceUsername' | 'maintenancePassword'>;
  readonly client: CalinApiV1Client;
};

type TokenAttempt = {
  token?: string;
  failureReason?: string;
};

/**
 * Build the token facet for `calin-api-v1`.
 *
 * @param deps - POS / maintenance credentials + HTTP client
 */
export function createCalinApiV1Token(
  deps: CreateCalinApiV1TokenDeps,
): NonNullable<DeviceMessagingPlugin['token']> {
  const { secrets, client } = deps;

  const posApiData = {
    company_name: secrets.companyName,
    user_name: secrets.posUsername,
    password: secrets.posPassword,
    password_vend: secrets.posPassword,
    is_vend_by_unit: true,
  };

  const maintenanceApiData = {
    company_name: secrets.companyName,
    user_name: secrets.maintenanceUsername,
    password: secrets.maintenancePassword,
  };

  const _generateTopupKwhToken = async (meterNumber: string, amount: number): Promise<TokenAttempt> => {
    const res = await client.sendRequest<CalinApiV1PosResponse>('/POS_Purchase', {
      ...posApiData,
      meter_number: meterNumber,
      amount,
    });
    return { token: res.result?.token, failureReason: res.reason };
  };

  const _generatePowerLimitToken = async (meterNumber: string, maxPower: number): Promise<TokenAttempt> => {
    const res = await client.sendRequest<CalinApiV1MaintenanceResponse>('/Maintenance_SetMaxPower', {
      ...maintenanceApiData,
      meter_number: meterNumber,
      max_power: maxPower,
    });
    return { token: res.result, failureReason: res.reason };
  };

  const _generateClearTamperToken = async (meterNumber: string): Promise<TokenAttempt> => {
    const res = await client.sendRequest<CalinApiV1MaintenanceResponse>(
      '/Maintenance_ClearTamper',
      {
        ...maintenanceApiData,
        meter_number: meterNumber,
      },
    );
    return { token: res.result, failureReason: res.reason };
  };

  const _generateClearCreditToken = async (meterNumber: string): Promise<TokenAttempt> => {
    const res = await client.sendRequest<CalinApiV1MaintenanceResponse>(
      '/Maintenance_ClearCredit',
      {
        ...maintenanceApiData,
        meter_number: meterNumber,
      },
    );
    return { token: res.result, failureReason: res.reason };
  };

  const generate = async (input: GenerateTokenInput): Promise<string> => {
    const { device, type } = input;
    const meterNumber = device.externalReference;
    let res: TokenAttempt;

    switch (type) {
      case 'TOP_UP_KWH': {
        res = await _generateTopupKwhToken(meterNumber, input.payload.kwh);
        break;
      }
      case 'SET_POWER_LIMIT': {
        res = await _generatePowerLimitToken(meterNumber, input.payload.powerLimit);
        break;
      }
      case 'CLEAR_TAMPER': {
        res = await _generateClearTamperToken(meterNumber);
        break;
      }
      case 'CLEAR_CREDIT': {
        res = await _generateClearCreditToken(meterNumber);
        break;
      }
      default: {
        throw new Error(`Can't generate a token for type ${ type }; not implemented.`);
      }
    }

    if (!res.token) {
      const base = '[CALIN API-V1 TOKEN SERVICE] Got an empty response';
      const message = res.failureReason
        ? `${ base } because: ${ res.failureReason }`
        : base;
      console.warn(message, { type });
      throw new Error(message);
    }

    return res.token;
  };

  return { generate };
}
