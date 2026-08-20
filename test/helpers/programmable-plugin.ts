/**
 * @fileoverview Programmable plugin + single-plugin registry for engine smokes.
 *
 * The bundled stubs always succeed (`sendOne` returns an id, `fetchStatus` returns
 * `null`), so they cannot drive failure, timeout or orphan paths. This builds a
 * {@link DeviceMessagingPlugin} whose vendor calls are supplied per test, and the
 * matching {@link PluginRegistry} literal to hand to the engine factories.
 *
 * Give each spec file its own plugin id so initial-queue keys never collide
 * between files (integration files share one Valkey and run serially).
 */

import { ulid } from 'ulid';

import { ENQUEUEABLE_COMMAND_TYPES } from '#src/lib/device-message/command-types.js';
import type {
  DeviceMessage,
  FailureContext,
  ParsedIncomingEvent,
  PluginId,
} from '#src/lib/device-message/types.js';
import { buildInitialQueueKey } from '#src/plugins/_shared/initial-queue-key.js';
import type {
  Admission,
  DeliveryPattern,
  DeviceMessagingPlugin,
  InitialQueueKeyInput,
  PluginTuning,
} from '#src/plugins/plugin.interface.js';
import type { PluginRegistry } from '#src/plugins/registry.js';

/** Stage timeouts a test does not care about. Override what the test drives. */
export const PROGRAMMABLE_DEFAULT_TUNING: PluginTuning = {
  nsInFlightTimeoutMs: 20_000,
  relayNodeInFlightTimeoutMs: 900_000,
  deviceInFlightTimeoutMs: 12_000,
  initialPollDelayMs: 10_000,
};

/** Queue-key `kind` segment per pattern, mirroring the bundled stubs. */
const NODE_KIND: Readonly<Record<DeliveryPattern, string>> = {
  PUSH: 'network',
  PULL: 'relayNode',
};

export type ProgrammablePluginOptions = {
  readonly id: PluginId;
  readonly deliveryPattern: DeliveryPattern;
  /** Defaults to near-instant `spacing` (PUSH) or `concurrency` of 5 (PULL). */
  readonly admission?: Admission;
  /** Merged over {@link PROGRAMMABLE_DEFAULT_TUNING}. */
  readonly tuning?: Partial<PluginTuning>;
  /** Defaults to resolving a unique external id. */
  readonly sendOne?: (message: DeviceMessage) => Promise<string>;
  /** Omitted by default, so a relay-node timeout goes straight to retryOrFail. */
  readonly getRemoteStatus?: (
    message: DeviceMessage,
  ) => Promise<{ readonly deliveryStatus: string }>;
  /** PULL status poll. Defaults to "still pending". */
  readonly fetchStatus?: (message: DeviceMessage) => Promise<ParsedIncomingEvent | null>;
  /** PUSH ingress parse. Defaults to accepting an already-normalized event. */
  readonly handle?: (event: unknown) => ParsedIncomingEvent | null;
  readonly parseError?: (err: unknown) => FailureContext;
};

/** Message ids passed to each vendor call, in call order. */
export type ProgrammablePluginCalls = {
  readonly sendOne: string[];
  readonly getRemoteStatus: string[];
  readonly fetchStatus: string[];
};

export type ProgrammablePlugin = {
  readonly plugin: DeviceMessagingPlugin;
  readonly registry: PluginRegistry;
  readonly calls: ProgrammablePluginCalls;
  /** The initial-queue key this plugin resolves for `input`. */
  initialQueueKey(input: InitialQueueKeyInput): string;
};

/** True when `event` already has the normalized incoming shape. */
function isParsedIncomingEvent(event: unknown): event is ParsedIncomingEvent {
  if (event === null || typeof event !== 'object') return false;
  const candidate = event as Partial<ParsedIncomingEvent>;
  return typeof candidate.deliveryStatus === 'string'
    && typeof candidate.device === 'object'
    && candidate.device !== null;
}

function defaultAdmission(deliveryPattern: DeliveryPattern): Admission {
  return deliveryPattern === 'PUSH'
    ? { strategy: 'spacing', minIntervalMs: 1 }
    : { strategy: 'concurrency', maxInFlight: 5 };
}

/**
 * Build a plugin with test-supplied vendor behaviour plus a registry holding only it.
 *
 * @param options - Plugin identity, admission / tuning overrides, and vendor calls
 */
export function createProgrammablePlugin(
  options: ProgrammablePluginOptions,
): ProgrammablePlugin {
  const { id, deliveryPattern } = options;
  const calls: ProgrammablePluginCalls = {
    sendOne: [],
    getRemoteStatus: [],
    fetchStatus: [],
  };

  const initialQueueKey = (input: InitialQueueKeyInput): string => {
    const nodePart = deliveryPattern === 'PUSH'
      ? input.networkId
      : input.device.relayNode?.id;
    return buildInitialQueueKey(
      id,
      NODE_KIND[deliveryPattern],
      nodePart == null ? 'unassigned' : String(nodePart),
    );
  };

  const plugin: DeviceMessagingPlugin = {
    id,
    deliveryPattern,
    supportedCommandTypes: ENQUEUEABLE_COMMAND_TYPES,
    admission: options.admission ?? defaultAdmission(deliveryPattern),
    tuning: { ...PROGRAMMABLE_DEFAULT_TUNING, ...options.tuning },
    initialQueueKey,
    outgoing: {
      async sendOne(message: DeviceMessage): Promise<string> {
        calls.sendOne.push(message.id);
        if (!options.sendOne) return `ext-${ ulid() }`;
        return options.sendOne(message);
      },
      parseError: options.parseError
        ?? ((err: unknown): FailureContext => ({
          reason: err instanceof Error ? err.message : String(err),
        })),
      ...(options.getRemoteStatus && {
        async getRemoteStatus(message: DeviceMessage) {
          calls.getRemoteStatus.push(message.id);
          return options.getRemoteStatus!(message);
        },
      }),
    },
    incoming: deliveryPattern === 'PUSH'
      ? {
        handle: options.handle
          ?? ((event: unknown) => (isParsedIncomingEvent(event) ? event : null)),
      }
      : {
        async fetchStatus(message: DeviceMessage): Promise<ParsedIncomingEvent | null> {
          calls.fetchStatus.push(message.id);
          if (!options.fetchStatus) return null;
          return options.fetchStatus(message);
        },
      },
  };

  const registry: PluginRegistry = {
    get: pluginId => (pluginId === id ? plugin : undefined),
    getAll: () => [ plugin ],
    getByDeliveryPattern: pattern => (pattern === deliveryPattern ? [ plugin ] : []),
  };

  return { plugin, registry, calls, initialQueueKey };
}
