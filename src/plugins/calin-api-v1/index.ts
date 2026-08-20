/**
 * @fileoverview `calin-api-v1` plugin factory (Unit 7 — Phase 2).
 *
 * PULL adapter for the CALIN HTTP API V1. Unit 7.1 lands SPI wiring (secrets,
 * admission, initial queue, tuning, catalog). Vendor I/O ports in 7.2–7.5.
 *
 * Enable: add `{ "id": "calin-api-v1" }` to config `plugins[]` and set
 * `CALIN_API_V1_*` env (see `.env.example`). Missing secrets fail at construct.
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
  InitialQueueKeyInput,
  PluginTuning,
  PullPlugin,
} from '../plugin.interface.js';
import { createCalinApiV1Incoming } from './incoming.js';
import { createCalinApiV1Client } from './lib/repo.js';
import { loadCalinApiV1Secrets } from './lib/secrets.js';
import { createCalinApiV1Outgoing } from './outgoing.js';
import { createCalinApiV1Token } from './token.js';

type PluginConfigEntry = DeviceMessagingConfig['plugins'][number];

/** Config / registry id. */
export const CALIN_API_V1_ID = 'calin-api-v1' as const;

/** Admission-node label in initial-queue keys (`queue:calin-api-v1:dcu:…`). */
const CALIN_API_V1_NODE_KIND = 'dcu' as const;

/**
 * Outbound command types this plugin implements.
 * Commented rows match legacy “not implemented” maps (kept for the port).
 */
const CALIN_API_V1_SUPPORTED_COMMAND_TYPES = [
  'READ_CREDIT',
  'READ_VOLTAGE',
  'READ_POWER',
  'READ_CURRENT',
  'READ_POWER_LIMIT',
  'READ_VERSION',
  'READ_DATE',
  // 'READ_TIME' — not implemented on CALIN API V1
  'TURN_ON',
  'TURN_OFF',
  'SET_DATE',
  // 'SET_TIME' — not implemented on CALIN API V1
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
const CALIN_API_V1_DEFAULT_TUNING: PluginTuning = {
  nsInFlightTimeoutMs: 20_000,
  relayNodeInFlightTimeoutMs: 900_000,
  deviceInFlightTimeoutMs: 12_000,
  initialPollDelayMs: 10_000,
};

const CALIN_API_V1_ADMISSION: Admission = {
  strategy: 'concurrency',
  maxInFlight: 5,
};

/**
 * Build the `calin-api-v1` {@link PullPlugin}.
 *
 * Validates secrets at construct (ADR-002 §6). Vendor I/O is fully wired
 * (Units 7.2–7.5: client, outgoing, incoming, token).
 *
 * @param entry - Config `plugins[]` entry for this id
 */
export function createCalinApiV1Plugin(entry: PluginConfigEntry): PullPlugin {
  const secrets = loadCalinApiV1Secrets();
  const client = createCalinApiV1Client({ apiBaseUrl: secrets.apiBaseUrl });
  const outgoing = createCalinApiV1Outgoing({ secrets, client });
  const incoming = createCalinApiV1Incoming({ secrets, client });
  const token = createCalinApiV1Token({ secrets, client });

  const tuning = mergePluginTuning(CALIN_API_V1_DEFAULT_TUNING, entry);

  const initialQueueKey = (input: InitialQueueKeyInput): string => {
    const relayNodeId = input.device.relayNode?.id;
    const dcuPart = relayNodeId == null ? 'unassigned' : String(relayNodeId);
    return buildInitialQueueKey(CALIN_API_V1_ID, CALIN_API_V1_NODE_KIND, dcuPart);
  };

  /** Enqueue requires a DCU id — do not park on `…:dcu:unassigned`. */
  const validateEnqueue = (create: CreateDeviceMessage): string | undefined => {
    if (create.device.relayNode?.id == null) {
      return 'device.relayNode.id is required';
    }
    return undefined;
  };

  return {
    id: CALIN_API_V1_ID,
    deliveryPattern: 'PULL',
    supportedCommandTypes: CALIN_API_V1_SUPPORTED_COMMAND_TYPES,
    admission: CALIN_API_V1_ADMISSION,
    tuning,
    initialQueueKey,
    validateEnqueue,
    outgoing,
    incoming,
    token,
  };
}
