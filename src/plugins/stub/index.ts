/**
 * @fileoverview No-op stub plugins for the walking-skeleton Intermezzo (I1).
 *
 * Two fixed ids so config can enable PUSH and/or PULL without vendor I/O.
 * Real CALIN / ChirpStack plugins land in Phase 2; do not reuse those ids here.
 */

import { ulid } from 'ulid';
import { z } from 'zod';

import type {
  Admission,
  DeliveryPattern,
  DeviceMessagingPlugin,
  InitialQueueKeyInput,
  PluginTuning,
} from '../plugin.interface.js';
import { buildInitialQueueKey } from '../initial-queue-key.js';
import type { DeviceMessagingConfig } from '../../config/schema.js';
import { ENQUEUEABLE_COMMAND_TYPES } from '../../lib/device-message/command-types.js';
import type {
  DeviceMessage,
  EnqueueableCommandType,
  FailureContext,
  GenerateTokenInput,
  ParsedIncomingEvent,
  PluginId,
} from '../../lib/device-message/types.js';

type PluginConfigEntry = DeviceMessagingConfig['plugins'][number];

/** Fixed token string returned by the PUSH stub's `token.generate`. */
export const STUB_TOKEN_VALUE = 'stub-token' as const;

/** Config / registry id for the PUSH stub. */
export const STUB_PUSH_ID = 'stub-push' as const;

/** Config / registry id for the PULL stub. */
export const STUB_PULL_ID = 'stub-pull' as const;

/** Human label in PUSH stub initial-queue keys (`queue:stub-push:network:…`). */
export const STUB_PUSH_NODE_KIND = 'network' as const;

/** Human label in PULL stub initial-queue keys (`queue:stub-pull:relayNode:…`). */
export const STUB_PULL_NODE_KIND = 'relayNode' as const;

/**
 * Default stage timeouts / poll delay for stubs (legacy delivery defaults).
 * Config `plugins[].tuning` overrides via {@link mergeStubTuning}.
 */
export const STUB_DEFAULT_TUNING: PluginTuning = {
  nsInFlightTimeoutMs: 20_000,
  relayNodeInFlightTimeoutMs: 900_000,
  deviceInFlightTimeoutMs: 12_000,
  initialPollDelayMs: 10_000,
};

/** Partial override shape for stub `plugins[].tuning` (unknown keys rejected). */
const stubTuningOverrideSchema = z.object({
  nsInFlightTimeoutMs: z.number().int().positive().optional(),
  relayNodeInFlightTimeoutMs: z.number().int().positive().optional(),
  deviceInFlightTimeoutMs: z.number().int().positive().optional(),
  initialPollDelayMs: z.number().int().positive().optional(),
}).strict();

/**
 * Merge config tuning overrides onto {@link STUB_DEFAULT_TUNING}.
 *
 * @throws If `entry.tuning` has unknown keys or invalid values
 */
export function mergeStubTuning(entry: PluginConfigEntry): PluginTuning {
  if (entry.tuning === undefined) {
    return STUB_DEFAULT_TUNING;
  }

  const parsed = stubTuningOverrideSchema.safeParse(entry.tuning);
  if (!parsed.success) {
    const detail = parsed.error.issues.map(issue => issue.message).join('; ');
    throw new Error(`Invalid tuning for plugin "${ entry.id }": ${ detail }`);
  }

  return { ...STUB_DEFAULT_TUNING, ...parsed.data };
}

const STUB_PUSH_ADMISSION: Admission = {
  strategy: 'spacing',
  minIntervalMs: 2000,
};

const STUB_PULL_ADMISSION: Admission = {
  strategy: 'concurrency',
  maxInFlight: 5,
};

function parseStubError(err: unknown): FailureContext {
  if (err instanceof Error) {
    return { reason: err.message };
  }
  return { reason: String(err) };
}

/**
 * True when `event` already looks like a {@link ParsedIncomingEvent}.
 * Stub PUSH ingress accepts the normalized shape so smokes need no vendor framing.
 */
function isStubParsedIncomingEvent(event: unknown): event is ParsedIncomingEvent {
  if (event === null || typeof event !== 'object') return false;
  const candidate = event as Partial<ParsedIncomingEvent>;
  return typeof candidate.deliveryStatus === 'string'
    && candidate.device !== null
    && typeof candidate.device === 'object'
    && !Array.isArray(candidate.device);
}

/**
 * Build a no-op {@link DeviceMessagingPlugin} for skeleton / tests.
 *
 * PULL stubs expose `incoming.fetchStatus` → `null`. PUSH stubs accept a
 * pre-normalized {@link ParsedIncomingEvent} body (or return null) and expose
 * `token.generate` → {@link STUB_TOKEN_VALUE}.
 */
export function createStubPlugin(options: {
  readonly id: PluginId;
  readonly deliveryPattern: DeliveryPattern;
  readonly nodeKind: string;
  readonly admission: Admission;
  /** Defaults to all enqueueable command types. */
  readonly supportedCommandTypes?: readonly EnqueueableCommandType[];
  /** Defaults to {@link STUB_DEFAULT_TUNING}. */
  readonly tuning?: PluginTuning;
}): DeviceMessagingPlugin {
  const {
    id,
    deliveryPattern,
    nodeKind,
    admission,
    supportedCommandTypes = ENQUEUEABLE_COMMAND_TYPES,
    tuning = STUB_DEFAULT_TUNING,
  } = options;

  const initialQueueKey = (input: InitialQueueKeyInput): string => {
    if (deliveryPattern === 'PUSH') {
      const networkPart = input.networkId == null ? 'unassigned' : String(input.networkId);
      return buildInitialQueueKey(id, nodeKind, networkPart);
    }
    const relayNodeId = input.device.relayNode?.id;
    const relayPart = relayNodeId == null ? 'unassigned' : String(relayNodeId);
    return buildInitialQueueKey(id, nodeKind, relayPart);
  };

  const outgoing: DeviceMessagingPlugin['outgoing'] = {
    async sendOne(_message: DeviceMessage): Promise<string> {
      // Unique per send so parallel Redis smokes do not share one external-id index.
      return `stub-ext-${ ulid() }`;
    },
    getRemoteStatus(_message: DeviceMessage): { deliveryStatus: string } {
      return { deliveryStatus: 'QUEUED' };
    },
    parseError: parseStubError,
  };

  const incoming: DeviceMessagingPlugin['incoming'] =
    deliveryPattern === 'PUSH'
      ? {
        handle: (event: unknown): ParsedIncomingEvent | null => {
          return isStubParsedIncomingEvent(event) ? event : null;
        },
      }
      : { fetchStatus: async (_message: DeviceMessage) => null };

  const token: DeviceMessagingPlugin['token'] | undefined =
    deliveryPattern === 'PUSH'
      ? {
        async generate(_input: GenerateTokenInput): Promise<string> {
          return STUB_TOKEN_VALUE;
        },
      }
      : undefined;

  return {
    id,
    deliveryPattern,
    supportedCommandTypes,
    admission,
    tuning,
    initialQueueKey,
    outgoing,
    incoming,
    ...(token !== undefined ? { token } : {}),
  };
}

/** Bundled PUSH stub (no vendor I/O). Merges config `tuning` over defaults. */
export function createStubPushPlugin(entry: PluginConfigEntry): DeviceMessagingPlugin {
  return createStubPlugin({
    id: STUB_PUSH_ID,
    deliveryPattern: 'PUSH',
    nodeKind: STUB_PUSH_NODE_KIND,
    admission: STUB_PUSH_ADMISSION,
    tuning: mergeStubTuning(entry),
  });
}

/** Bundled PULL stub (no vendor I/O). Merges config `tuning` over defaults. */
export function createStubPullPlugin(entry: PluginConfigEntry): DeviceMessagingPlugin {
  return createStubPlugin({
    id: STUB_PULL_ID,
    deliveryPattern: 'PULL',
    nodeKind: STUB_PULL_NODE_KIND,
    admission: STUB_PULL_ADMISSION,
    tuning: mergeStubTuning(entry),
  });
}
