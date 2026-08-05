/**
 * @fileoverview `nxt-sts` token facet (Unit 8.2).
 *
 * Port of legacy `adapters/nxt-sts/_token.service.ts`.
 * Wire type is `TOP_UP_KWH` (vendor STS API still expects `TOP_UP`).
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
 * Map wire generate-token `type` to the STS vendor enum.
 *
 * @param type - Wire {@link GenerateTokenInput} discriminant
 */
function toVendorTokenType(
  type: GenerateTokenInput['type'],
): NxtStsTokenRequest['type'] {
  return type === 'TOP_UP_KWH' ? 'TOP_UP' : type;
}

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
    const decoderKey = device.decoderKey;
    if (decoderKey === undefined || decoderKey.trim() === '') {
      throw new NxtStsError('[NXT STS TOKEN SERVICE] device.decoderKey is required');
    }

    const body: NxtStsTokenRequest = {
      decoderKey,
      randomNumber: generateRandomNumber(STS_RANDOM_NUMBER_MAX),
      issueDate: issueDateString,
      type: toVendorTokenType(type),
      ...(type === 'TOP_UP_KWH' ? { kwh: input.payload.kwh } : {}),
      ...(type === 'SET_POWER_LIMIT' ? { powerLimit: input.payload.powerLimit } : {}),
    };

    const { token } = await client.sendTokenRequest(body);
    if (!token) {
      throw new NxtStsError('[NXT STS TOKEN SERVICE] Failed to generate token');
    }
    return token;
  };

  return { generate };
}
