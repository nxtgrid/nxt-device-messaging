/**
 * @fileoverview `calin-chirpstack` plugin factory (Unit 10 — Phase 2).
 *
 * PUSH adapter: CALIN meter framing over ChirpStack (legacy folder
 * `adapters/calin-lorawan/`). Units 10.1–10.5: SPI, shared gRPC client,
 * encode/decode/correlate, outgoing, incoming.
 *
 * ChirpStack gRPC secrets stay vendor-scoped (`CHIRPSTACK_*`) in
 * `_shared/chirpstack-repository/` — loaded when that client is created.
 *
 * Enable: add `{ "id": "calin-chirpstack" }` to config `plugins[]` and set
 * `CHIRPSTACK_*` env (see `.env.example`). Missing secrets fail when the
 * shared client is constructed.
 */

import type { DeviceMessagingConfig } from '../../config/schema.js';
import type { EnqueueableCommandType } from '../../lib/device-message/types.js';
import { createChirpstackClient } from '../_shared/chirpstack-repository/index.js';
import { buildInitialQueueKey } from '../_shared/initial-queue-key.js';
import { mergePluginTuning } from '../_shared/merge-plugin-tuning.js';
import type {
  Admission,
  InitialQueueKeyInput,
  PushPlugin,
} from '../plugin.interface.js';
import { createCalinChirpstackIncoming } from './incoming.js';
import { createCalinChirpstackOutgoing } from './outgoing.js';

type PluginConfigEntry = DeviceMessagingConfig['plugins'][number];

/** Config / registry id. */
export const CALIN_CHIRPSTACK_ID = 'calin-chirpstack' as const;

/** Admission-node label in initial-queue keys (`queue:calin-chirpstack:network:…`). */
const CALIN_CHIRPSTACK_NODE_KIND = 'network' as const;

/**
 * Outbound command types this plugin implements (legacy encode maps).
 * Token mint is out of band (`nxt-sts`); this plugin only delivers tokens.
 */
const CALIN_CHIRPSTACK_SUPPORTED_COMMAND_TYPES = [
  'READ_CREDIT',
  'READ_VOLTAGE',
  'READ_POWER',
  'READ_CURRENT',
  'READ_POWER_LIMIT',
  // 'READ_VERSION' — not in legacy LoRaWAN encode map
  'READ_DATE',
  'READ_TIME',
  'TURN_ON',
  'TURN_OFF',
  'SET_DATE',
  'SET_TIME',
  'TOP_UP_KWH',
  'SET_POWER_LIMIT',
  'CLEAR_TAMPER',
  'CLEAR_CREDIT',
  'DELIVER_PREEXISTING_TOKEN',
] as const satisfies readonly EnqueueableCommandType[];

/** Flood lock — one claim per network (or unassigned) every 2s (ADR-006). */
const CALIN_CHIRPSTACK_ADMISSION: Admission = {
  strategy: 'spacing',
  minIntervalMs: 2_000,
};

/**
 * Build the `calin-chirpstack` {@link PushPlugin}.
 *
 * Creates the shared ChirpStack gRPC client (secrets from env). Outgoing and
 * incoming are fully wired (Units 10.4–10.5).
 *
 * @param entry - Config `plugins[]` entry for this id
 */
export function createCalinChirpstackPlugin(entry: PluginConfigEntry): PushPlugin {
  const client = createChirpstackClient();
  const tuning = mergePluginTuning(entry);

  const initialQueueKey = (input: InitialQueueKeyInput): string => {
    const networkPart = input.networkId == null ? 'unassigned' : String(input.networkId);
    return buildInitialQueueKey(
      CALIN_CHIRPSTACK_ID,
      CALIN_CHIRPSTACK_NODE_KIND,
      networkPart,
    );
  };

  return {
    id: CALIN_CHIRPSTACK_ID,
    deliveryPattern: 'PUSH',
    supportedCommandTypes: CALIN_CHIRPSTACK_SUPPORTED_COMMAND_TYPES,
    admission: CALIN_CHIRPSTACK_ADMISSION,
    tuning,
    initialQueueKey,
    outgoing: createCalinChirpstackOutgoing({ client }),
    incoming: createCalinChirpstackIncoming(),
  };
}
