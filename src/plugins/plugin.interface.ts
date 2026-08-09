/**
 * @fileoverview Plugin SPI (Unit 6).
 *
 * Normative surface for hardware integrations. Plugins are plain objects (ADR-001).
 * Admission declaration lives here (ADR-006); execution is
 * `OutgoingService.distributeToNetworkServers` (Unit 5.3 / D3).
 * Initial queues: {@link DeviceMessagingPlugin.initialQueueKey} + `buildInitialQueueKey`
 * (ADR-006 D1). Stage timeouts / poll delay: {@link PluginTuning} (D5).
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

/** How confirmation works after send — not inferred from the initial-queue key (ADR-006 §3). */
export type DeliveryPattern = 'PUSH' | 'PULL';

/**
 * Optional HTTP context for PUSH {@link DeviceMessagingPlugin.incoming.handle}.
 * Plain strings only — no framework types (ADR-001).
 */
export type IncomingHandleMeta = {
  readonly query: Readonly<Record<string, string>>;
};

/**
 * Inputs for {@link DeviceMessagingPlugin.initialQueueKey}.
 * Not the full create DTO — only network + device (incl. optional `relayNode`).
 */
export type InitialQueueKeyInput = {
  networkId: number | null;
  device: DeviceMessageDevice;
};

/**
 * Context passed to custom admission hooks.
 * Widened in Unit 5 if distribute needs more fields.
 */
export type DistributeCtx = {
  readonly queueKey: string;
  readonly pluginId: PluginId;
};

/**
 * Named admission strategies (ADR-006 §2).
 * Core executes `spacing` / `concurrency`; plugins only declare (or supply `custom` hooks).
 */
export type Admission =
  | { readonly strategy: 'spacing'; readonly minIntervalMs: number }
  | {
    readonly strategy: 'concurrency';
    readonly maxInFlight: number;
  }
  | {
    readonly strategy: 'custom';
    canDistribute(ctx: DistributeCtx): Promise<boolean>;
    onClaim?(ctx: DistributeCtx & { messageId: string }): Promise<void>;
    onRelease?(ctx: DistributeCtx & { messageId: string }): Promise<void>;
  };

/**
 * Per-plugin stage timeouts / poll delay (D5 / ADR-002 §5).
 * Defaults live in plugin code; config `plugins[].tuning` overrides (Unit 6.2 Step F).
 * Shared `delivery` keeps only retry knobs + message TTL.
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

/**
 * Hardware integration contract.
 *
 * Convention (not enforced by the type system):
 * - `PUSH` plugins implement `incoming.handle` and usually `outgoing.getRemoteStatus`
 * - `PULL` plugins implement `incoming.fetchStatus` (no `getRemoteStatus`)
 */
export type DeviceMessagingPlugin = {
  /** Unique, URL-safe id (e.g. `calin-chirpstack`). */
  readonly id: PluginId;

  /** Post-send confirmation pattern. */
  readonly deliveryPattern: DeliveryPattern;

  /**
   * Outbound command types this plugin accepts on enqueue (ADR-003 §4).
   * Wire vocabulary is {@link EnqueueableCommandType}; this list is the subset gate.
   */
  readonly supportedCommandTypes: readonly EnqueueableCommandType[];

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

  /** Stage timeouts / initial poll delay (D5). */
  readonly tuning: PluginTuning;

  outgoing: {
    /** Send to the network server / vendor API. Returns external delivery id. */
    sendOne(message: DeviceMessage): Promise<string>;
    /**
     * Remote queue status (PUSH relay-node timeout extension).
     * Optional — PULL plugins omit it.
     */
    getRemoteStatus?(
      message: DeviceMessage,
    ): Promise<{ deliveryStatus: string }> | { deliveryStatus: string };
    /** Map a thrown error into retry/fail context. */
    parseError(err: unknown): FailureContext;
  };

  incoming: {
    /**
     * PUSH: normalize a raw webhook payload (or null to ignore).
     * HTTP may pass {@link IncomingHandleMeta} (e.g. ChirpStack `?event=`).
     */
    handle?(
      event: unknown,
      meta?: IncomingHandleMeta,
    ): ParsedIncomingEvent | null;
    /** PULL: poll vendor status for an in-flight message. */
    fetchStatus?(message: DeviceMessage): Promise<ParsedIncomingEvent | null>;
    /** PUSH ingress: optional signature check (ADR-003). */
    verifySignature?(
      rawBody: Buffer,
      headers: Record<string, string>,
    ): boolean | Promise<boolean>;
  };

  /** Optional STS / vendor token capability. */
  token?: {
    generate(input: GenerateTokenInput): Promise<string>;
  };
};
