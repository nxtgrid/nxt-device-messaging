/**
 * @fileoverview No-op stub plugins.
 *
 * Two fixed ids so config can enable PUSH and/or PULL without vendor I/O.
 * Do not reuse these ids for vendor plugins.
 */

import { isNil } from 'ramda';
import { ulid } from 'ulid';

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
import { buildInitialQueueKey } from '../_shared/initial-queue-key.js';
import {
  DEFAULT_PLUGIN_TUNING,
  mergePluginTuning,
} from '../_shared/merge-plugin-tuning.js';
import type {
  Admission,
  InitialQueueKeyInput,
  PluginTuning,
  PullPlugin,
  PushPlugin,
} from '../plugin.interface.js';

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

const STUB_PUSH_ADMISSION: Admission = {
  strategy: 'spacing',
  minIntervalMs: 2000,
};

const STUB_PULL_ADMISSION: Admission = {
  strategy: 'concurrency',
  maxInFlight: 5,
};

type StubSharedOptions = {
  readonly id: PluginId;
  readonly nodeKind: string;
  readonly admission: Admission;
  /** Defaults to all enqueueable command types. */
  readonly supportedCommandTypes?: readonly EnqueueableCommandType[];
  /** Defaults to {@link DEFAULT_PLUGIN_TUNING}. */
  readonly tuning?: PluginTuning;
};

export type StubPushOptions = StubSharedOptions & {
  readonly deliveryPattern: 'PUSH';
};

export type StubPullOptions = StubSharedOptions & {
  readonly deliveryPattern: 'PULL';
};

function parseStubError(err: unknown): FailureContext {
  if (err instanceof Error) {
    return { reason: err.message };
  }
  return { reason: String(err) };
}

async function stubSendOne(_message: DeviceMessage): Promise<string> {
  // Unique per send so parallel Redis smokes do not share one external-id index.
  return `stub-ext-${ ulid() }`;
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

function stubPushInitialQueueKey(
  id: PluginId,
  nodeKind: string,
  input: InitialQueueKeyInput,
): string {
  const networkPart = isNil(input.networkId) ? 'unassigned' : String(input.networkId);
  return buildInitialQueueKey(id, nodeKind, networkPart);
}

function stubPullInitialQueueKey(
  id: PluginId,
  nodeKind: string,
  input: InitialQueueKeyInput,
): string {
  const relayNodeId = input.device.relayNode?.id;
  const relayPart = isNil(relayNodeId) ? 'unassigned' : String(relayNodeId);
  return buildInitialQueueKey(id, nodeKind, relayPart);
}

function buildStubPush(options: StubPushOptions): PushPlugin {
  const {
    id,
    nodeKind,
    admission,
    supportedCommandTypes = ENQUEUEABLE_COMMAND_TYPES,
    tuning = DEFAULT_PLUGIN_TUNING,
  } = options;

  return {
    id,
    deliveryPattern: 'PUSH',
    supportedCommandTypes,
    admission,
    tuning,
    initialQueueKey: input => stubPushInitialQueueKey(id, nodeKind, input),
    outgoing: {
      sendOne: stubSendOne,
      parseError: parseStubError,
      getRemoteStatus(_message: DeviceMessage): { deliveryStatus: string } {
        return { deliveryStatus: 'QUEUED' };
      },
    },
    incoming: {
      handle: (event: unknown): ParsedIncomingEvent | null => {
        return isStubParsedIncomingEvent(event) ? event : null;
      },
    },
    token: {
      async generate(_input: GenerateTokenInput): Promise<string> {
        return STUB_TOKEN_VALUE;
      },
    },
  };
}

function buildStubPull(options: StubPullOptions): PullPlugin {
  const {
    id,
    nodeKind,
    admission,
    supportedCommandTypes = ENQUEUEABLE_COMMAND_TYPES,
    tuning = DEFAULT_PLUGIN_TUNING,
  } = options;

  return {
    id,
    deliveryPattern: 'PULL',
    supportedCommandTypes,
    admission,
    tuning,
    initialQueueKey: input => stubPullInitialQueueKey(id, nodeKind, input),
    outgoing: {
      sendOne: stubSendOne,
      parseError: parseStubError,
    },
    incoming: {
      fetchStatus: async (_message: DeviceMessage) => null,
    },
  };
}

/**
 * Build a no-op delivery stub for skeleton / tests.
 *
 * PULL stubs expose `incoming.fetchStatus` → `null`. PUSH stubs accept a
 * pre-normalized {@link ParsedIncomingEvent} body (or return null) and expose
 * `token.generate` → {@link STUB_TOKEN_VALUE}.
 */
export function createStubPlugin(options: StubPushOptions): PushPlugin;
export function createStubPlugin(options: StubPullOptions): PullPlugin;
export function createStubPlugin(
  options: StubPushOptions | StubPullOptions,
): PushPlugin | PullPlugin {
  if (options.deliveryPattern === 'PUSH') {
    return buildStubPush(options);
  }
  return buildStubPull(options);
}

/** Bundled PUSH stub (no vendor I/O). Merges config `tuning` over defaults. */
export function createStubPushPlugin(entry: PluginConfigEntry): PushPlugin {
  return createStubPlugin({
    id: STUB_PUSH_ID,
    deliveryPattern: 'PUSH',
    nodeKind: STUB_PUSH_NODE_KIND,
    admission: STUB_PUSH_ADMISSION,
    tuning: mergePluginTuning(entry),
  });
}

/** Bundled PULL stub (no vendor I/O). Merges config `tuning` over defaults. */
export function createStubPullPlugin(entry: PluginConfigEntry): PullPlugin {
  return createStubPlugin({
    id: STUB_PULL_ID,
    deliveryPattern: 'PULL',
    nodeKind: STUB_PULL_NODE_KIND,
    admission: STUB_PULL_ADMISSION,
    tuning: mergePluginTuning(entry),
  });
}
