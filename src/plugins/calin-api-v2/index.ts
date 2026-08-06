/**
 * @fileoverview `calin-api-v2` plugin factory (Unit 9 — Phase 2).
 *
 * PULL adapter for the CALIN HTTP API V2. Unit 9.1 lands SPI wiring (secrets,
 * admission, initial queue, tuning, catalog). Client + outgoing + incoming in
 * 9.2–9.4; token in 9.5.
 *
 * Enable: add `{ "id": "calin-api-v2" }` to config `plugins[]` and set
 * `CALIN_API_V2_*` env (see `.env.example`). Missing secrets fail at construct.
 */

import type { DeviceMessagingConfig } from '../../config/schema.js';
import type {
  CreateDeviceMessage,
  EnqueueableCommandType,
} from '../../lib/device-message/types.js';
import { buildInitialQueueKey } from '../_shared/initial-queue-key.js';
import { mergePluginTuning } from '../_shared/merge-plugin-tuning.js';
import type {
  Admission,
  DeviceMessagingPlugin,
  InitialQueueKeyInput,
  PluginTuning,
} from '../plugin.interface.js';
import { createCalinApiV2Incoming } from './incoming.js';
import { createCalinApiV2Client } from './lib/repo.js';
import { loadCalinApiV2Secrets } from './lib/secrets.js';
import { createCalinApiV2Outgoing } from './outgoing.js';

type PluginConfigEntry = DeviceMessagingConfig['plugins'][number];

/** Config / registry id. */
export const CALIN_API_V2_ID = 'calin-api-v2' as const;

/** Admission-node label in initial-queue keys (`queue:calin-api-v2:dcu:…`). */
const CALIN_API_V2_NODE_KIND = 'dcu' as const;

/**
 * Outbound command types this plugin implements.
 * Commented rows match legacy “not implemented” maps (kept for the port).
 */
const CALIN_API_V2_SUPPORTED_COMMAND_TYPES = [
  'READ_CREDIT',
  'READ_VOLTAGE',
  'READ_POWER',
  'READ_CURRENT',
  'READ_POWER_LIMIT',
  'READ_VERSION',
  'READ_DATE',
  // 'READ_POWER_DOWN_COUNT' — not implemented on CALIN API V2
  'TURN_ON',
  'TURN_OFF',
  'SET_DATE',
  // 'SET_TIME' — not implemented on CALIN API V2
  'TOP_UP_KWH',
  'SET_POWER_LIMIT',
  'CLEAR_TAMPER',
  'CLEAR_CREDIT',
  'DELIVER_PREEXISTING_TOKEN',
] as const satisfies readonly EnqueueableCommandType[];

/**
 * Default stage timeouts / poll delay (legacy delivery defaults).
 * Config `plugins[].tuning` overrides via {@link mergePluginTuning}.
 */
const CALIN_API_V2_DEFAULT_TUNING: PluginTuning = {
  nsInFlightTimeoutMs: 20_000,
  relayNodeInFlightTimeoutMs: 900_000,
  deviceInFlightTimeoutMs: 12_000,
  initialPollDelayMs: 10_000,
};

const CALIN_API_V2_ADMISSION: Admission = {
  strategy: 'concurrency',
  maxInFlight: 5,
};

/**
 * Build the `calin-api-v2` {@link DeviceMessagingPlugin}.
 *
 * Validates secrets at construct (ADR-002 §6). Outgoing + incoming are wired
 * (Units 9.3–9.4); token stays a stub until 9.5.
 *
 * @param entry - Config `plugins[]` entry for this id
 */
export function createCalinApiV2Plugin(entry: PluginConfigEntry): DeviceMessagingPlugin {
  const secrets = loadCalinApiV2Secrets();
  const client = createCalinApiV2Client({
    apiBaseUrl: secrets.apiBaseUrl,
    adminUsername: secrets.adminUsername,
    adminPassword: secrets.adminPassword,
    companyName: secrets.companyName,
  });
  const outgoing = createCalinApiV2Outgoing({ secrets, client });
  const incoming = createCalinApiV2Incoming({ secrets, client });

  const tuning = mergePluginTuning(CALIN_API_V2_DEFAULT_TUNING, entry);

  const initialQueueKey = (input: InitialQueueKeyInput): string => {
    const relayNodeId = input.device.relayNode?.id;
    const dcuPart = relayNodeId == null ? 'unassigned' : String(relayNodeId);
    return buildInitialQueueKey(CALIN_API_V2_ID, CALIN_API_V2_NODE_KIND, dcuPart);
  };

  /** Enqueue requires a DCU id — do not park on `…:dcu:unassigned`. */
  const validateEnqueue = (create: CreateDeviceMessage): string | undefined => {
    if (create.device.relayNode?.id == null) {
      return 'device.relayNode.id is required';
    }
    return undefined;
  };

  const generate = async (): Promise<string> => {
    throw new Error('[calin-api-v2] token not ported yet (Unit 9.5)');
  };

  return {
    id: CALIN_API_V2_ID,
    deliveryPattern: 'PULL',
    supportedCommandTypes: CALIN_API_V2_SUPPORTED_COMMAND_TYPES,
    admission: CALIN_API_V2_ADMISSION,
    tuning,
    initialQueueKey,
    validateEnqueue,
    outgoing,
    incoming,
    token: { generate },
  };
}
