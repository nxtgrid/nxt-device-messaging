/**
 * @fileoverview No-op stub plugins for the walking-skeleton Intermezzo (I1).
 *
 * Two fixed ids so config can enable PUSH and/or PULL without vendor I/O.
 * Real CALIN / ChirpStack plugins land in Phase 2; do not reuse those ids here.
 */

import type {
  Admission,
  BottleneckKeyInput,
  DeliveryPattern,
  DeviceMessagingPlugin,
} from '../plugin.interface.js';
import type { DeviceMessagingConfig } from '../../config/schema.js';
import type { DeviceMessage, FailureContext, PluginId } from '../../lib/device-message/types.js';

/** Config / registry id for the PUSH stub. */
export const STUB_PUSH_ID = 'stub-push' as const;

/** Config / registry id for the PULL stub. */
export const STUB_PULL_ID = 'stub-pull' as const;

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
 * Build a no-op {@link DeviceMessagingPlugin} for skeleton / tests.
 *
 * PULL stubs expose `incoming.fetchStatus` → `null`; PUSH stubs expose
 * `incoming.handle` → `null`.
 */
export function createStubPlugin(options: {
  readonly id: PluginId;
  readonly deliveryPattern: DeliveryPattern;
  readonly admission: Admission;
}): DeviceMessagingPlugin {
  const { id, deliveryPattern, admission } = options;

  const bottleneckKey = (input: BottleneckKeyInput): string => {
    if (deliveryPattern === 'PUSH') {
      const networkPart = input.networkId == null ? 'unassigned' : String(input.networkId);
      return `queue:stub_network:${ networkPart }`;
    }
    const gatewayId = input.device.gateway?.id;
    const gatewayPart = gatewayId == null ? 'unassigned' : String(gatewayId);
    return `queue:stub_gateway:${ gatewayPart }`;
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
      ? { handle: (_event: unknown) => null }
      : { fetchStatus: async (_message: DeviceMessage) => null };

  return {
    id,
    deliveryPattern,
    admission,
    bottleneckKey,
    outgoing,
    incoming,
  };
}

/** Bundled PUSH stub (no vendor I/O). Config entry reserved for later settings/tuning. */
export function createStubPushPlugin(
  _entry: DeviceMessagingConfig['plugins'][number],
): DeviceMessagingPlugin {
  return createStubPlugin({
    id: STUB_PUSH_ID,
    deliveryPattern: 'PUSH',
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
    admission: STUB_PULL_ADMISSION,
  });
}
