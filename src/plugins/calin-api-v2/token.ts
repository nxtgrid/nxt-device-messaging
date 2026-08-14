/**
 * @fileoverview `calin-api-v2` token facet (Unit 9.5).
 *
 * Port of legacy `adapters/calin-api-v2/_token.service.ts`.
 * Wire type is `TOP_UP_KWH` (not legacy `TOP_UP`). `serialNumber` uses
 * `crypto.randomUUID()` (no `uuid` package).
 */

import { randomUUID } from 'node:crypto';

import type { GenerateTokenInput } from '../../lib/device-message/types.js';
import { logger } from '../../log.js';
import type { DeviceMessagingPlugin } from '../plugin.interface.js';
import type {
  CalinApiV2Client,
  CalinApiV2TaskDataResponse,
} from './lib/repo.js';
import type { CalinApiV2Secrets } from './lib/secrets.js';

type CreateCalinApiV2TokenDeps = {
  readonly secrets: Pick<CalinApiV2Secrets, 'companyName' | 'posPassword'>;
  readonly client: CalinApiV2Client;
};

type TokenAttempt = {
  token?: string;
  failureReason?: string;
};

/**
 * Build the token facet for `calin-api-v2`.
 *
 * @param deps - Company / POS password + HTTP client
 */
export function createCalinApiV2Token(
  deps: CreateCalinApiV2TokenDeps,
): NonNullable<DeviceMessagingPlugin['token']> {
  const { secrets, client } = deps;

  const _generateTopupKwhToken = async (
    meterId: string,
    amount: number,
  ): Promise<TokenAttempt> => {
    const res = await client.sendRequest<CalinApiV2TaskDataResponse>(
      '/API/Token/CreditToken/Generate',
      {
        meterId,
        amount,
        company: secrets.companyName,
        authorizationPassword: secrets.posPassword,
        isPreview: false,
        isVendByTotalPaid: false,
        serialNumber: randomUUID(),
      },
    );
    return { token: res.result?.token, failureReason: res.reason };
  };

  const _generatePowerLimitToken = async (
    meterId: string,
    maximumPower: number,
  ): Promise<TokenAttempt> => {
    const res = await client.sendRequest<CalinApiV2TaskDataResponse>(
      '/API/Token/SetMaximumPowerLimitToken/Generate',
      {
        meterId,
        maximumPower,
        company: secrets.companyName,
      },
    );
    return { token: res.result?.token, failureReason: res.reason };
  };

  const _generateClearTamperToken = async (meterId: string): Promise<TokenAttempt> => {
    const res = await client.sendRequest<CalinApiV2TaskDataResponse>(
      '/API/Token/ClearTamperToken/Generate',
      {
        meterId,
        company: secrets.companyName,
      },
    );
    return { token: res.result?.token, failureReason: res.reason };
  };

  const _generateClearCreditToken = async (meterId: string): Promise<TokenAttempt> => {
    const res = await client.sendRequest<CalinApiV2TaskDataResponse>(
      '/API/Token/ClearCreditToken/Generate',
      {
        meterId,
        company: secrets.companyName,
      },
    );
    return { token: res.result?.token, failureReason: res.reason };
  };

  const generate = async (input: GenerateTokenInput): Promise<string> => {
    const { device, type } = input;
    const meterId = device.externalReference;
    let res: TokenAttempt;

    switch (type) {
      case 'TOP_UP_KWH': {
        res = await _generateTopupKwhToken(meterId, input.payload.kwh);
        break;
      }
      case 'SET_POWER_LIMIT': {
        res = await _generatePowerLimitToken(meterId, input.payload.powerLimit);
        break;
      }
      case 'CLEAR_TAMPER': {
        res = await _generateClearTamperToken(meterId);
        break;
      }
      case 'CLEAR_CREDIT': {
        res = await _generateClearCreditToken(meterId);
        break;
      }
      default: {
        throw new Error(`Can't generate a token for type ${ type }; not implemented.`);
      }
    }

    if (!res.token) {
      const base = '[CALIN API-V2 TOKEN SERVICE] Got an empty response';
      const message = res.failureReason
        ? `${ base } because: ${ res.failureReason }`
        : base;
      logger.warn({
        module: 'calin-api-v2.token',
        type,
        failureReason: res.failureReason,
      }, 'empty token response');
      throw new Error(message);
    }

    return res.token;
  };

  return { generate };
}
