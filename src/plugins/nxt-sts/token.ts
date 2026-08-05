/**
 * @fileoverview `nxt-sts` token facet (Unit 8).
 *
 * Port of legacy `adapters/nxt-sts/_token.service.ts`.
 * Wire type is `TOP_UP_KWH` (vendor STS API still expects `TOP_UP`).
 *
 * Unit 8.1: stub — real fetch client + mint land in 8.2.
 */

import type { GenerateTokenInput } from '../../lib/device-message/types.js';
import type { DeviceMessagingPlugin } from '../plugin.interface.js';
import type { NxtStsSecrets } from './lib/secrets.js';

type CreateNxtStsTokenDeps = {
  readonly secrets: NxtStsSecrets;
};

/**
 * Build the token facet for `nxt-sts`.
 *
 * @param deps - API base URL from secrets (used in 8.2)
 */
export function createNxtStsToken(
  deps: CreateNxtStsTokenDeps,
): NonNullable<DeviceMessagingPlugin['token']> {
  void deps;

  const generate = async (_input: GenerateTokenInput): Promise<string> => {
    throw new Error('[NXT STS TOKEN SERVICE] Not implemented');
  };

  return { generate };
}
