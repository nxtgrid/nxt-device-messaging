/**
 * @fileoverview `sparkmeter-sparknet-http` plugin factory.
 *
 * PUSH adapter for sparknet-http (meter-driver-spec). One initial queue per
 * basestation. Interim admission is concurrency 1 until the meter hold lands.
 *
 * `sendOne` throws until the configure post is added. Enable with
 * `plugins[].settings.basestations` and `meterConfiguration`.
 */

import { isNil } from 'ramda';

import type { DeviceMessagingConfig } from '../../config/schema.js';
import type {
  CreateDeviceMessage,
  DeviceMessage,
  EnqueueableCommandType,
  FailureContext,
} from '../../lib/device-message/types.js';
import { buildInitialQueueKey } from '../_shared/initial-queue-key.js';
import { mergePluginTuning } from '../_shared/merge-plugin-tuning.js';
import type {
  Admission,
  InitialQueueKeyInput,
  PluginTuning,
  PushPlugin,
} from '../plugin.interface.js';
import { createSparkmeterSparknetHttpIncoming } from './incoming.js';
import { loadSparkmeterSparknetHttpSettings } from './settings.js';
import { validateSparkmeterEnqueue } from './validate-enqueue.js';

type PluginConfigEntry = DeviceMessagingConfig['plugins'][number];

/** Config / registry id. */
export const SPARKMETER_SPARKNET_HTTP_ID = 'sparkmeter-sparknet-http' as const;

/** Admission-node label in initial-queue keys (`queue:…:basestation:…`). */
const BASESTATION_NODE_KIND = 'basestation' as const;

const SUPPORTED_COMMAND_TYPES = [
  'TURN_ON',
  'TURN_OFF',
  'SET_POWER_LIMIT',
] as const satisfies readonly EnqueueableCommandType[];

/** One HTTP call at a time per basestation queue, until the meter hold exists. */
const ADMISSION: Admission = {
  strategy: 'concurrency',
  maxInFlight: 1,
};

/**
 * Emulator deadlines. The production device wait is chosen at the
 * real-basestation trial. `plugins[].tuning` overrides any key.
 * `initialPollDelayMs` stays the core default; this plugin does not poll.
 */
const DEVELOPMENT_STAGE_TIMEOUTS: Partial<PluginTuning> = {
  nsInFlightTimeoutMs: 10_000,
  relayNodeInFlightTimeoutMs: 30_000,
  deviceInFlightTimeoutMs: 60_000,
};

/** Configure posting is the next slice. The SPI still requires `sendOne`. */
async function sendOne(_message: DeviceMessage): Promise<string> {
  throw new Error('sparkmeter-sparknet-http sendOne is not implemented');
}

function parseError(err: unknown): FailureContext {
  const reason = err instanceof Error ? err.message : String(err);
  return { reason };
}

/**
 * Build the `sparkmeter-sparknet-http` {@link PushPlugin}.
 *
 * Validates settings at construct (ADR-002).
 *
 * @param entry - Config `plugins[]` entry for this id
 */
export function createSparkmeterSparknetHttpPlugin(entry: PluginConfigEntry): PushPlugin {
  const settings = loadSparkmeterSparknetHttpSettings(entry);
  const basestationIds = new Set(settings.basestations.map(basestation => basestation.id));
  const tuning = mergePluginTuning(entry, DEVELOPMENT_STAGE_TIMEOUTS);
  const incoming = createSparkmeterSparknetHttpIncoming();

  const initialQueueKey = (input: InitialQueueKeyInput): string => {
    const relayNodeId = input.device.relayNode?.id;
    const basestationPart = isNil(relayNodeId) ? 'unassigned' : String(relayNodeId);
    return buildInitialQueueKey(
      SPARKMETER_SPARKNET_HTTP_ID,
      BASESTATION_NODE_KIND,
      basestationPart,
    );
  };

  const validateEnqueue = (create: CreateDeviceMessage): string | undefined => {
    return validateSparkmeterEnqueue(create, basestationIds);
  };

  return {
    id: SPARKMETER_SPARKNET_HTTP_ID,
    deliveryPattern: 'PUSH',
    supportedCommandTypes: SUPPORTED_COMMAND_TYPES,
    relayNodeNoun: BASESTATION_NODE_KIND,
    admission: ADMISSION,
    tuning,
    initialQueueKey,
    validateEnqueue,
    outgoing: { sendOne, parseError },
    incoming,
  };
}
