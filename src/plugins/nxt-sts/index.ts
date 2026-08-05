/**
 * @fileoverview `nxt-sts` plugin factory (Unit 8 — Phase 2).
 *
 * Token-only adapter for the NXT STS generator API (ADR-003 §3). No enqueue /
 * delivery path — `supportedCommandTypes` is empty; `outgoing.sendOne` rejects.
 * Unit 8.1 lands SPI wiring (secrets, catalog, stubs). Vendor mint lands in 8.2.
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
import { buildInitialQueueKey } from '../_shared/initial-queue-key.js';
import { mergePluginTuning } from '../_shared/merge-plugin-tuning.js';
import type {
  Admission,
  DeviceMessagingPlugin,
  InitialQueueKeyInput,
  PluginTuning,
} from '../plugin.interface.js';
import { loadNxtStsSecrets } from './lib/secrets.js';
import { createNxtStsToken } from './token.js';

type PluginConfigEntry = DeviceMessagingConfig['plugins'][number];

/** Config / registry id. */
export const NXT_STS_ID = 'nxt-sts' as const;

/**
 * Admission-node label in initial-queue keys (`queue:nxt-sts:none:na`).
 * Token-only — distribute never claims these queues.
 */
const NXT_STS_NODE_KIND = 'none' as const;

/** No enqueueable commands — sync token mint only. */
const NXT_STS_SUPPORTED_COMMAND_TYPES = [] as const satisfies readonly EnqueueableCommandType[];

/**
 * Default stage timeouts / poll delay (unused for distribute; SPI-required).
 * Config `plugins[].tuning` overrides via {@link mergePluginTuning}.
 */
const NXT_STS_DEFAULT_TUNING: PluginTuning = {
  nsInFlightTimeoutMs: 20_000,
  relayNodeInFlightTimeoutMs: 900_000,
  deviceInFlightTimeoutMs: 12_000,
  initialPollDelayMs: 10_000,
};

const NXT_STS_ADMISSION: Admission = {
  strategy: 'concurrency',
  maxInFlight: 1,
};

/**
 * Build the `nxt-sts` {@link DeviceMessagingPlugin}.
 *
 * Validates secrets at construct (ADR-002 §6). Token mint is stubbed until 8.2.
 *
 * @param entry - Config `plugins[]` entry for this id
 */
export function createNxtStsPlugin(entry: PluginConfigEntry): DeviceMessagingPlugin {
  const secrets = loadNxtStsSecrets();
  const token = createNxtStsToken({ secrets });
  const tuning = mergePluginTuning(NXT_STS_DEFAULT_TUNING, entry);

  const initialQueueKey = (_input: InitialQueueKeyInput): string => {
    return buildInitialQueueKey(NXT_STS_ID, NXT_STS_NODE_KIND, 'na');
  };

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
    deliveryPattern: 'PULL',
    supportedCommandTypes: NXT_STS_SUPPORTED_COMMAND_TYPES,
    admission: NXT_STS_ADMISSION,
    tuning,
    initialQueueKey,
    outgoing: { sendOne, parseError },
    incoming: {},
    token,
  };
}
