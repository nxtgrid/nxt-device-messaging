/**
 * @fileoverview `nxt-sts` plugin factory.
 *
 * Token-only adapter for the NXT STS generator API (ADR-003 §3). No enqueue /
 * delivery path — `supportedCommandTypes` is empty; `outgoing.sendOne` rejects.
 * `deliveryPattern` is `'NONE'`: no admission, tuning, initial queue, or incoming.
 *
 * Enable: add `{ "id": "nxt-sts" }` to config `plugins[]` and set `NXT_STS_URL`
 * (see `.env.example`). Missing secrets fail at construct.
 */

import type { DeviceMessagingConfig } from '../../config/schema.js';
import type {
  DeviceMessage,
  EnqueueableCommandType,
  FailureContext,
} from '../../lib/device-message/types.js';
import type { TokenOnlyPlugin } from '../plugin.interface.js';
import { createNxtStsClient } from './lib/repo.js';
import { loadNxtStsSecrets } from './lib/secrets.js';
import { createNxtStsToken } from './token.js';

type PluginConfigEntry = DeviceMessagingConfig['plugins'][number];

/** Config / registry id. */
export const NXT_STS_ID = 'nxt-sts' as const;

/** No enqueueable commands — sync token mint only. */
const NXT_STS_SUPPORTED_COMMAND_TYPES = [] as const satisfies readonly EnqueueableCommandType[];

/**
 * Build the `nxt-sts` {@link TokenOnlyPlugin}.
 *
 * Validates secrets at construct (ADR-002 §6). Vendor mint via native `fetch`.
 *
 * @param entry - Config `plugins[]` entry for this id
 */
export function createNxtStsPlugin(_entry: PluginConfigEntry): TokenOnlyPlugin {
  const secrets = loadNxtStsSecrets();
  const client = createNxtStsClient({ apiBaseUrl: secrets.apiBaseUrl });
  const token = createNxtStsToken({ client });

  const sendOne = async (_message: DeviceMessage): Promise<string> => {
    throw new Error('[NXT STS] Delivery is not supported (token-only plugin)');
  };

  const parseError = (err: unknown): FailureContext => {
    if (err instanceof Error) {
      return { reason: err.message };
    }
    return { reason: String(err) };
  };

  return {
    id: NXT_STS_ID,
    deliveryPattern: 'NONE',
    supportedCommandTypes: NXT_STS_SUPPORTED_COMMAND_TYPES,
    outgoing: { sendOne, parseError },
    token,
  };
}
