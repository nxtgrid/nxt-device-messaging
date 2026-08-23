/**
 * @fileoverview Plugin SPI.
 *
 * Normative surface for hardware integrations. Plugins are plain objects (ADR-001).
 * Admission declaration lives here (ADR-006); execution is
 * `OutgoingService.distributeToNetworkServers`.
 * Initial queues: {@link DeliveryPlugin.initialQueueKey} + `buildInitialQueueKey`
 * (ADR-006). Stage timeouts / poll delay: {@link PluginTuning}.
 *
 * The SPI is a discriminated union on {@link DeliveryPattern}:
 * {@link PushPlugin} | {@link PullPlugin} | {@link TokenOnlyPlugin}.
 */

import type {
  CreateDeviceMessage,
  DeviceMessage,
  DeviceMessageDevice,
  EnqueueableCommandType,
  FailureContext,
  GenerateTokenInput,
  ParsedIncomingEvent,
  PluginId,
} from '../lib/device-message/types.js';

/**
 * How confirmation works after send — not inferred from the initial-queue key
 * (ADR-006 §3). `'NONE'` is token-only: no delivery path.
 */
export type DeliveryPattern = 'PUSH' | 'PULL' | 'NONE';

/**
 * Optional HTTP context for PUSH {@link PushPlugin} `incoming.handle`.
 * Plain strings only — no framework types (ADR-001).
 */
export type IncomingHandleMeta = {
  readonly query: Readonly<Record<string, string>>;
};

/**
 * Inputs for {@link DeliveryPlugin.initialQueueKey}.
 * Not the full create DTO — only network + device (incl. optional `relayNode`).
 */
export type InitialQueueKeyInput = {
  networkId: number | null;
  device: DeviceMessageDevice;
};

/**
 * Named admission strategies (ADR-006 §2).
 * Core executes `spacing` / `concurrency`; plugins only declare which one.
 */
export type Admission =
  | {
    readonly strategy: 'spacing';
    /**
     * Minimum gap between picks from the same initial queue.
     * Observed on the 1 s engine tick — use whole seconds (e.g. `2000`).
     */
    readonly minIntervalMs: number;
  }
  | {
    readonly strategy: 'concurrency';
    readonly maxInFlight: number;
  };

/**
 * Per-plugin stage timeouts / poll delay (ADR-002 §5).
 * Core owns `DEFAULT_PLUGIN_TUNING`; plugins call `mergePluginTuning(entry)`
 * and pass only deltas. Config `plugins[].tuning` overrides.
 * Shared `delivery` keeps only retry knobs + message TTL.
 * Delivery plugins only — token-only plugins have no stage timers.
 * Timeouts are scored against a 1 s engine tick; whole seconds are the useful grain.
 */
export type PluginTuning = {
  /** Score timeout on `queue_in_flight_to_ns`. */
  readonly nsInFlightTimeoutMs: number;
  /** Score timeout on `queue_in_flight_to_relay_node` (PUSH mid stage). */
  readonly relayNodeInFlightTimeoutMs: number;
  /** Score timeout on `queue_in_flight_to_device` (end meter). */
  readonly deviceInFlightTimeoutMs: number;
  /** Delay before first PULL status poll. */
  readonly initialPollDelayMs: number;
};

/** STS / vendor token mint. Optional on delivery plugins; required on token-only. */
export type PluginToken = {
  generate(input: GenerateTokenInput): Promise<string>;
};

/**
 * Send + error mapping shared by every plugin, including token-only
 * (`sendOne` throws to document the refusal).
 */
type PluginOutgoingBase = {
  /** Send to the network server / vendor API. Returns external delivery id. */
  sendOne(message: DeviceMessage): Promise<string>;
  /** Map a thrown error into retry/fail context. */
  parseError(err: unknown): FailureContext;
};

/**
 * Fields common to every plugin. Delivery-only fields (`admission`, `tuning`,
 * `initialQueueKey`, `incoming`) live on {@link PushPlugin} / {@link PullPlugin}.
 */
type PluginBase = {
  /** Unique, URL-safe id (e.g. `calin-chirpstack`). */
  readonly id: PluginId;

  /**
   * Outbound command types this plugin accepts on enqueue (ADR-003 §4).
   * Wire vocabulary is {@link EnqueueableCommandType}; this list is the subset gate.
   * Empty on token-only plugins.
   */
  readonly supportedCommandTypes: readonly EnqueueableCommandType[];

  outgoing: PluginOutgoingBase;

  /** Optional STS / vendor token capability (required on {@link TokenOnlyPlugin}). */
  token?: PluginToken;
};

/**
 * Delivery-only fields shared by {@link PushPlugin} and {@link PullPlugin}.
 * Token-only plugins omit all of these.
 */
type DeliveryPluginBase = PluginBase & {
  /**
   * Redis initial-queue key for a message (ADR-006 §1).
   * Prefer `buildInitialQueueKey` so keys are `queue:{pluginId}:{kind}:{id}`.
   */
  initialQueueKey(input: InitialQueueKeyInput): string;

  /**
   * Optional enqueue-only checks beyond `supportedCommandTypes`.
   * Return an error detail string to reject (engine → `InvalidEnqueueError` / HTTP 400).
   * Not called on cancel / requeue.
   */
  validateEnqueue?(create: CreateDeviceMessage): string | undefined;

  /** How hard the distributor may hit this plugin's initial queues. */
  readonly admission: Admission;

  /** Stage timeouts / initial poll delay. */
  readonly tuning: PluginTuning;
};

/**
 * PUSH delivery plugin: webhook ingress after send.
 * `incoming.handle` is required. `outgoing.getRemoteStatus` is optional
 * (relay-node timeout extension). `incoming.fetchStatus` is forbidden.
 */
export type PushPlugin = DeliveryPluginBase & {
  readonly deliveryPattern: 'PUSH';

  outgoing: PluginOutgoingBase & {
    /**
     * Remote queue status (PUSH relay-node timeout extension).
     * Optional — omit when the vendor has no queue to inspect.
     */
    getRemoteStatus?(
      message: DeviceMessage,
    ): Promise<{ deliveryStatus: string }> | { deliveryStatus: string };
  };

  incoming: {
    /**
     * Normalize a raw webhook payload (or null to ignore).
     * HTTP may pass {@link IncomingHandleMeta} (e.g. ChirpStack `?event=`).
     */
    handle(
      event: unknown,
      meta?: IncomingHandleMeta,
    ): ParsedIncomingEvent | null;
    fetchStatus?: never;
    /** PUSH ingress: optional signature check (ADR-003). */
    verifySignature?(
      rawBody: Buffer,
      headers: Record<string, string>,
    ): boolean | Promise<boolean>;
  };
};

/**
 * PULL delivery plugin: poll vendor status after send.
 * `incoming.fetchStatus` is required. `outgoing.getRemoteStatus` and
 * `incoming.handle` are forbidden.
 */
export type PullPlugin = DeliveryPluginBase & {
  readonly deliveryPattern: 'PULL';

  outgoing: PluginOutgoingBase & {
    getRemoteStatus?: never;
  };

  incoming: {
    /** Poll vendor status for an in-flight message. */
    fetchStatus(message: DeviceMessage): Promise<ParsedIncomingEvent | null>;
    handle?: never;
    verifySignature?: never;
  };
};

/**
 * Token-only plugin: mint tokens, no delivery path.
 * Has no `admission`, `tuning`, `initialQueueKey`, or `incoming`.
 * `outgoing.sendOne` still exists and throws — documents the refusal.
 */
export type TokenOnlyPlugin = PluginBase & {
  readonly deliveryPattern: 'NONE';
  token: PluginToken;
  outgoing: PluginOutgoingBase & {
    getRemoteStatus?: never;
  };
  incoming?: never;
  admission?: never;
  tuning?: never;
  initialQueueKey?: never;
  validateEnqueue?: never;
};

/** Hardware integration contract — discriminated on {@link DeliveryPattern}. */
export type DeviceMessagingPlugin = PushPlugin | PullPlugin | TokenOnlyPlugin;

/** Delivery plugins (enqueue / distribute / ingress / poll). Excludes token-only. */
export type DeliveryPlugin = PushPlugin | PullPlugin;

/** Map from {@link DeliveryPattern} to the matching union member. */
export type PluginByDeliveryPattern = {
  [P in DeviceMessagingPlugin as P['deliveryPattern']]: P;
};
