/**
 * @fileoverview No-op stub plugins for the walking-skeleton Intermezzo (I1).
 *
 * Two fixed ids so config can enable PUSH and/or PULL without vendor I/O.
 * Real CALIN / ChirpStack plugins land in Phase 2; do not reuse those ids here.
 */

import type {
  Admission,
  DeliveryPattern,
  DeviceMessagingPlugin,
  GenerateTokenInput,
  InitialQueueKeyInput,
} from '../plugin.interface.js';
import { buildInitialQueueKey } from '../initial-queue-key.js';
import type { DeviceMessagingConfig } from '../../config/schema.js';
import type {
  DeviceMessage,
  FailureContext,
  ParsedIncomingEvent,
  PluginId,
} from '../../lib/device-message/types.js';

/** Fixed token string returned by the PUSH stub's `token.generate`. */
export const STUB_TOKEN_VALUE = 'stub-token' as const;

/** Config / registry id for the PUSH stub. */
export const STUB_PUSH_ID = 'stub-push' as const;

/** Config / registry id for the PULL stub. */
export const STUB_PULL_ID = 'stub-pull' as const;

/** Human label in PUSH stub initial-queue keys (`queue:stub-push:network:…`). */
export const STUB_PUSH_NODE_KIND = 'network' as const;

/** Human label in PULL stub initial-queue keys (`queue:stub-pull:gateway:…`). */
export const STUB_PULL_NODE_KIND = 'gateway' as const;

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
    && candidate.device !== undefined
    && typeof candidate.device === 'object';
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
}): DeviceMessagingPlugin {
  const { id, deliveryPattern, nodeKind, admission } = options;

  const initialQueueKey = (input: InitialQueueKeyInput): string => {
    if (deliveryPattern === 'PUSH') {
      const networkPart = input.networkId == null ? 'unassigned' : String(input.networkId);
      return buildInitialQueueKey(id, nodeKind, networkPart);
    }
    const gatewayId = input.device.gateway?.id;
    const gatewayPart = gatewayId == null ? 'unassigned' : String(gatewayId);
    return buildInitialQueueKey(id, nodeKind, gatewayPart);
  };

  const outgoing: DeviceMessagingPlugin['outgoing'] = {
    async sendOne(_message: DeviceMessage): Promise<string> {
      return 'stub-ext-id';
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
    admission,
    initialQueueKey,
    outgoing,
    incoming,
    ...(token !== undefined ? { token } : {}),
  };
}

/** Bundled PUSH stub (no vendor I/O). Config entry reserved for later settings/tuning. */
export function createStubPushPlugin(
  _entry: DeviceMessagingConfig['plugins'][number],
): DeviceMessagingPlugin {
  return createStubPlugin({
    id: STUB_PUSH_ID,
    deliveryPattern: 'PUSH',
    nodeKind: STUB_PUSH_NODE_KIND,
    admission: STUB_PUSH_ADMISSION,
  });
}

/** Bundled PULL stub (no vendor I/O). Config entry reserved for later settings/tuning. */
export function createStubPullPlugin(
  _entry: DeviceMessagingConfig['plugins'][number],
): DeviceMessagingPlugin {
  return createStubPlugin({
    id: STUB_PULL_ID,
    deliveryPattern: 'PULL',
    nodeKind: STUB_PULL_NODE_KIND,
    admission: STUB_PULL_ADMISSION,
  });
}
