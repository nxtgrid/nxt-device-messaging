/**
 * @fileoverview Core domain types for device command delivery.
 *
 * Ported from nxt-backend `legacy/.../device-messages/lib/types.ts` (baseline db5c2ac)
 * with ADR-003 renames and plugin selection. Domain + Redis hash fields are camelCase
 * (Intermezzo I3). Plugin-specific command predicates and helpers stay with plugins
 * (Phase 2). Delivery pattern (PUSH/PULL) is declared on each plugin; the registry
 * exposes that to the engine. PULL awaiting-task keys use `pluginId` (ADR-006); initial
 * queues use plugin `bottleneckKey`, not a core switch.
 */

/**
 * Electrical phase for per-phase commands. When set, Redis correlation indexes append
 * `_ph{phase}` so one logical read (e.g. voltage) can enqueue three messages.
 */
export type PhaseEnum = 'A' | 'B' | 'C';

/**
 * Opaque plugin id; core routes by this string.
 * Bundled ids are documented in ADR-003 §3 and declared on each plugin object — not listed here.
 */
export type PluginId = string;

export type GatewayInfo = {
  id?: number;
  externalReference?: string;
  snr?: number;
  rssi?: number;
};

/** Types of devices we can communicate with. */
export type DeviceType = 'ELECTRICITY_METER';

/** Outcome of command execution on the device. */
export type MessageResponseStatus = 'EXECUTION_SUCCESS' | 'EXECUTION_FAILURE';

export type SetDatePayload = {
  year: number;
  month: number;
  day: number;
};

export type SetTimePayload = {
  hour: number;
  minute: number;
  second?: number;
};

/**
 * Delivery status representing the message's position in the delivery pipeline.
 *
 * Flow: QUEUED → SENT_TO_NS → DELIVERED_TO_NS → SENT_TO_DEVICE → DELIVERY_SUCCESSFUL
 *       ↓ (on failure at any step)
 *       TO_RETRY → QUEUED (retry) or DELIVERY_FAILED (max retries exceeded)
 */
export type DeviceMessageDeliveryStatus =
  | 'QUEUED'
  | 'TO_RETRY'
  | 'SENT_TO_NS'
  | 'DELIVERED_TO_NS'
  | 'SENT_TO_DEVICE'
  | 'DELIVERY_SUCCESSFUL'
  | 'DELIVERY_FAILED';

/**
 * Target device identity only (ADR-003 §3).
 * Manufacturer/protocol selection is replaced by {@link CreateDeviceMessage.pluginId}.
 */
export type DeviceMessageDevice = {
  /** Device category. */
  type: DeviceType;
  /** Unique identifier (e.g., meter serial number). */
  externalReference: string;
  /** Gateway that relays messages to this device. */
  gateway?: GatewayInfo;
};

/**
 * Context provided when a delivery attempt fails.
 * Used as input to retryOrFail and by network server adapters.
 */
export type FailureContext = {
  /** Human-readable description of what went wrong. */
  reason: string;
  /** gRPC or HTTP error code from the network server. */
  errorCode?: number | string;
  /** Additional error context (e.g., gRPC details, constraint names). */
  details?: string;
  /** If true, skip retries and fail immediately (unrecoverable error). */
  skipRetry?: boolean;
};

/**
 * Record of a delivery attempt failure, stored in failureHistory.
 */
export type FailureReason = {
  /** Human-readable description of what went wrong. */
  reason: string;
  /** gRPC or HTTP error code from the network server. */
  errorCode?: number | string;
  /** Additional error context (e.g., gRPC details, constraint names). */
  details?: string;
  /** Delivery status when the failure occurred. */
  status: DeviceMessageDeliveryStatus;
  /** ISO timestamp of the failure. */
  timestamp: string;
  /** Flags whether this is the final failure. */
  isFinal?: boolean;
};

/**
 * Result of a cancel operation for a single correlation id.
 * Returned by cancel-one / cancel-many Redis helpers.
 */
export type CancelMessageResult = {
  correlationId: string;
  /** CANCELLED: all messages removed. NOT_CANCELLABLE: at least one was in-flight. NOT_FOUND: no messages in Redis. */
  result: 'CANCELLED' | 'NOT_CANCELLABLE' | 'NOT_FOUND';
};

/**
 * Fields supplied when enqueuing a command (former CreateDeviceMessageDto).
 * HTTP enqueue Zod (`src/http/schemas.ts`) matches this shape (ADR-003 §2–§3).
 */
export type CreateDeviceMessage = {
  /** Opaque command type; plugins validate and close the set (ADR-003 §4). */
  commandType: string;
  priority: number;
  /** Plugin that will deliver this command. */
  pluginId: PluginId;
  /** Payload for delivery, optional. */
  requestData?: {
    token?: string;
    payload?: SetDatePayload | SetTimePayload;
  };
  /**
   * Electrical phase when the command is phase-specific.
   * Drives Redis index key suffix `_ph{phase}` so multi-phase reads enqueue one message each.
   */
  phase?: PhaseEnum;
  /**
   * Network (grid) the device belongs to.
   * `null` means unbound (orphan / test); LoRaWAN routes to the `unassigned` bucket.
   */
  networkId: number | null;
  /** Caller-supplied opaque correlation handle (former meter_interaction_id). */
  correlationId?: string;
  device: DeviceMessageDevice;
};

/**
 * A message to be delivered to a remote device.
 *
 * Lifecycle:
 * 1. Created via CreateDeviceMessage and enqueued
 * 2. Moves through delivery queues (NS → GW → Device)
 * 3. Receives response or times out
 * 4. On failure: retries with backoff or fails permanently
 */
export type DeviceMessage = CreateDeviceMessage & {
  /** Unique identifier (ULID). */
  id: string;
  /** External queue ID from network server (ChirpStack, Calin API, etc.). */
  deliveryQueueId: string;
  /** Current position in delivery pipeline. */
  deliveryStatus: DeviceMessageDeliveryStatus;
  /** Response data from the device (on success). */
  response?: {
    status: MessageResponseStatus;
    /** Opaque object payload; plugins own the concrete shape. */
    data?: Record<string, unknown>;
  };
  /** True if device sent this message without being asked. */
  unsolicited?: boolean;
  /** Number of delivery attempts (0 = first attempt). */
  retryCount?: number;
  /** History of failed delivery attempts. */
  failureHistory?: FailureReason[];
};

/**
 * Parsed event from network server webhook (almost a partial DeviceMessage).
 * Used by PUSH/PULL plugins to normalize vendor payloads into a common shape.
 */
export type ParsedIncomingEvent = {
  /** Opaque command type (optional for ACK events). */
  commandType?: string;
  /** External queue ID to correlate with stored message. */
  deliveryQueueId?: string;
  /** New delivery status based on event type. */
  deliveryStatus: DeviceMessageDeliveryStatus;
  /** Device information from the event. */
  device: DeviceMessageDevice;
  /** Response payload from device (for uplink events). */
  response?: {
    status: MessageResponseStatus;
    /** Opaque object payload; plugins own the concrete shape. */
    data?: Record<string, unknown>;
  };
  /** True if this is an unsolicited uplink from the device. */
  unsolicited?: boolean;
  failureContext?: FailureContext;
};
