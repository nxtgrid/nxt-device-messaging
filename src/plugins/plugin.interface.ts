/**
 * @fileoverview Minimal plugin SPI (pre–Unit 5).
 *
 * Normative surface for hardware integrations. Plugins are plain objects (ADR-001).
 * Admission declaration lives here (ADR-006); execution of named strategies is Unit 5 (D3).
 * `queueKey → plugin` via boot-time `bottleneckKind` (ADR-006 D1-B). Stage-timeout
 * relocation (D5) is not here.
 *
 * Unit 4 interim facets (`PushIncoming` / `PushOutgoing` / `PullIncoming`) are deleted once
 * the engine types against this SPI.
 */

import type {
  DeviceMessage,
  DeviceMessageDevice,
  FailureContext,
  ParsedIncomingEvent,
  PluginId,
} from '../lib/device-message/types.js';

/** How confirmation works after send — not inferred from bottleneck kind (ADR-006 §3). */
export type DeliveryPattern = 'PUSH' | 'PULL';

/**
 * Topology inputs for {@link DeviceMessagingPlugin.bottleneckKey}.
 * Not the full create DTO — only network + device (incl. DCU/gateway).
 */
export type BottleneckKeyInput = {
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
    /** Redis set of in-flight message ids; parsing stays in the plugin if needed. */
    readonly trackKey?: (queueKey: string) => string;
  }
  | {
    readonly strategy: 'custom';
    canDistribute(ctx: DistributeCtx): Promise<boolean>;
    onClaim?(ctx: DistributeCtx & { messageId: string }): Promise<void>;
    onRelease?(ctx: DistributeCtx & { messageId: string }): Promise<void>;
  };

/**
 * Token generation input (domain shape). HTTP Zod lands in Phase 3 (ADR-003).
 * `type` is opaque to core; the plugin closes the set.
 */
export type GenerateTokenInput = {
  type: string;
  issueDateString: string;
  device: {
    externalReference: string;
    decoderKey?: string;
  };
  payload?: {
    kwh?: number;
    powerLimit?: number;
  };
};

/**
 * Hardware integration contract.
 *
 * Convention (not enforced by the type system):
 * - `PUSH` plugins implement `incoming.handle`
 * - `PULL` plugins implement `incoming.fetchStatus`
 */
export type DeviceMessagingPlugin = {
  /** Unique, URL-safe id (e.g. `calin-chirpstack`). */
  readonly id: PluginId;

  /** Post-send confirmation pattern. */
  readonly deliveryPattern: DeliveryPattern;

  /**
   * Middle segment of this plugin's initial-queue keys (`queue:{kind}:{id}`).
   * Must be unique among enabled plugins (ADR-006 D1-B). Used only to resolve
   * the owning plugin at distribute time — never to choose admission policy.
   */
  readonly bottleneckKind: string;

  /**
   * Full Redis initial-queue key for a message (ADR-006 §1).
   * Core does not build or parse bottleneck topology for policy.
   */
  bottleneckKey(input: BottleneckKeyInput): string;

  /** How hard the distributor may hit this plugin's bottleneck queues. */
  readonly admission: Admission;

  outgoing: {
    /** Send to the network server / vendor API. Returns external delivery id. */
    sendOne(message: DeviceMessage): Promise<string>;
    /** Remote queue status (PUSH GW extension). */
    getRemoteStatus(
      message: DeviceMessage,
    ): Promise<{ deliveryStatus: string }> | { deliveryStatus: string };
    /** Map a thrown error into retry/fail context. */
    parseError(err: unknown): FailureContext;
  };

  incoming: {
    /** PUSH: normalize a raw webhook payload (or null to ignore). */
    handle?(event: unknown): ParsedIncomingEvent | null;
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
