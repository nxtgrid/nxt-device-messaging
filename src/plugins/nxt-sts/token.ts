/**
 * @fileoverview `nxt-sts` token facet (Unit 8.2).
 *
 * Port of legacy `adapters/nxt-sts/_token.service.ts`.
 * Wire generate-token types match the STS `POST /token` `type` field
 * (`TOP_UP_KWH`, etc.).
 */

import type { GenerateTokenInput } from '../../lib/device-message/types.js';
import { generateRandomNumber } from '../_shared/generate-random-number.js';
import type { DeviceMessagingPlugin } from '../plugin.interface.js';
import type { NxtStsClient, NxtStsTokenRequest } from './lib/repo.js';
import { NxtStsError } from './lib/repo.js';

/** Exclusive upper bound passed to legacy `generateRandomNumber` (yields 0..11). */
const STS_RANDOM_NUMBER_MAX = 12;

type CreateNxtStsTokenDeps = {
  readonly client: NxtStsClient;
};

/**
 * Build the token facet for `nxt-sts`.
 *
 * @param deps - HTTP client (base URL from secrets)
 */
export function createNxtStsToken(
  deps: CreateNxtStsTokenDeps,
): NonNullable<DeviceMessagingPlugin['token']> {
  const { client } = deps;

  const generate = async (input: GenerateTokenInput): Promise<string> => {
    const { type, issueDateString, device } = input;
    const decoderKey = device.decoderKey?.trim();
    if (decoderKey === undefined || decoderKey === '') {
      throw new NxtStsError('[NXT STS TOKEN SERVICE] device.decoderKey is required');
    }

    const body: NxtStsTokenRequest = {
      decoderKey,
      randomNumber: generateRandomNumber(STS_RANDOM_NUMBER_MAX),
      issueDate: issueDateString,
      type,
      ...(type === 'TOP_UP_KWH' ? { kwh: input.payload.kwh } : {}),
      ...(type === 'SET_POWER_LIMIT' ? { powerLimit: input.payload.powerLimit } : {}),
    };

    const { token } = await client.sendTokenRequest(body);
    if (typeof token !== 'string' || token === '') {
      throw new NxtStsError('[NXT STS TOKEN SERVICE] Failed to generate token');
    }
    return token;
  };

  return { generate };
}
