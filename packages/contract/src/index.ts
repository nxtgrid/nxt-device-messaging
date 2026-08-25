/**
 * @fileoverview Adopter-facing HTTP and webhook wire contract.
 *
 * Route-level allowlist for `@nxt/device-messaging-contract`. Engine-only types
 * (`DeviceMessage`, `FailureContext`, `ParsedIncomingEvent`, Redis records)
 * and ingress path params are not exported.
 */

import type { z } from 'zod';

import { webhookEventSchema as webhookEventSchemaSource } from '../../../src/engine/webhook/event-schema.js';
import * as responseSchemas from '../../../src/http/response-schemas.js';
import type * as commands from '../../../src/lib/device-message/command-types.js';
import * as messageSchemas from '../../../src/lib/device-message/schemas.js';

/**
 * Commands accepted on `POST /message/enqueue`.
 * Reads, control, clock writes, and token delivery — not {@link UnsolicitedCommandType}.
 *
 * `READ_VOLTAGE` / `READ_CURRENT` also need `phase` on {@link CreateDeviceMessage}.
 * `SET_DATE` / `SET_TIME` put {@link SetDatePayload} / {@link SetTimePayload} on
 * `requestData.payload`. `DELIVER_PREEXISTING_TOKEN` puts the token on
 * `requestData.token`.
 */
export type EnqueueableCommandType = commands.EnqueueableCommandType;

/**
 * Device-originated events (`READ_REPORT`, `JOIN_NETWORK`).
 * They can appear on GET/webhook; they are not valid on enqueue.
 */
export type UnsolicitedCommandType = commands.UnsolicitedCommandType;

/**
 * `commandType` on GET/webhook: {@link EnqueueableCommandType} plus
 * {@link UnsolicitedCommandType}.
 */
export type CommandType = commands.CommandType;

/**
 * Electrical phase (`A` / `B` / `C`). Set `phase` on enqueue when
 * `commandType` is `READ_VOLTAGE` or `READ_CURRENT`.
 */
export type PhaseEnum = z.infer<typeof messageSchemas.phaseSchema>;

/**
 * `requestData.payload` when enqueueing `SET_DATE`.
 * Year may be 2- or 4-digit depending on the plugin.
 */
export type SetDatePayload = z.infer<typeof messageSchemas.setDatePayloadSchema>;

/** `requestData.payload` when enqueueing `SET_TIME`. */
export type SetTimePayload = z.infer<typeof messageSchemas.setTimePayloadSchema>;

/**
 * JSON body for `POST /message/enqueue`.
 *
 * Required: `commandType` ({@link EnqueueableCommandType}), `priority` (higher is
 * more urgent), `pluginId` (enabled on the server), `device` (`type` +
 * `externalReference`), `networkId` (`null` if not network-scoped).
 *
 * Pass `correlationId` if you will later `GET /message/:correlationId` or cancel —
 * the server does not mint one. Omitting it means you cannot look the message up
 * on the command API.
 *
 * Validate with {@link createDeviceMessageSchema}.
 */
export type CreateDeviceMessage = z.infer<typeof messageSchemas.createDeviceMessageSchema>;

/**
 * Runtime validator for {@link CreateDeviceMessage} (`POST /message/enqueue`).
 */
export const createDeviceMessageSchema = messageSchemas.createDeviceMessageSchema;

/**
 * Delivery status on {@link DeviceMessageResponse} and {@link WebhookEvent}.message.
 *
 * Happy path: `QUEUED` → `SENT_TO_NS` → `DELIVERED_TO_NS` → `SENT_TO_DEVICE` →
 * `DELIVERY_SUCCESSFUL`. On failure: `TO_RETRY` (then `QUEUED` again) or
 * `DELIVERY_FAILED` when retries are exhausted.
 */
export type DeviceMessageDeliveryStatus = z.infer<typeof messageSchemas.deliveryStatusSchema>;

/**
 * Runtime validator for {@link DeviceMessageDeliveryStatus}.
 */
export const deliveryStatusSchema = messageSchemas.deliveryStatusSchema;

/**
 * Message after `POST /message/enqueue` (`201`) or `GET /message/:correlationId`
 * (`200`).
 *
 * Switch on `deliveryStatus` ({@link DeviceMessageDeliveryStatus}). `commandType`
 * is {@link CommandType} (wider than enqueue). `correlationId` is missing for
 * unsolicited uplinks and for enqueues that omitted it. Device outcome is
 * `response`; past failures are `failureHistory`.
 *
 * Validate with {@link deviceMessageResponseSchema}.
 */
export type DeviceMessageResponse = z.infer<typeof messageSchemas.deviceMessageResponseSchema>;

/**
 * Runtime validator for {@link DeviceMessageResponse}.
 */
export const deviceMessageResponseSchema = messageSchemas.deviceMessageResponseSchema;

/**
 * JSON body for `POST /message/cancel` (one correlation id).
 */
export type CancelOneBody = z.infer<typeof messageSchemas.cancelOneBodySchema>;

/**
 * Runtime validator for {@link CancelOneBody}.
 */
export const cancelOneBodySchema = messageSchemas.cancelOneBodySchema;

/**
 * JSON body for `POST /messages/cancel` (one or more correlation ids).
 */
export type CancelManyBody = z.infer<typeof messageSchemas.cancelManyBodySchema>;

/**
 * Runtime validator for {@link CancelManyBody}.
 */
export const cancelManyBodySchema = messageSchemas.cancelManyBodySchema;

/**
 * Cancel outcome for one correlation id.
 * `POST /message/cancel` returns one; `POST /messages/cancel` returns an array.
 *
 * - `CANCELLED` — removed before in-flight
 * - `NOT_CANCELLABLE` — at least one message already in-flight
 * - `NOT_FOUND` — no messages for that id
 */
export type CancelMessageResult = z.infer<typeof messageSchemas.cancelMessageResultSchema>;

/**
 * Runtime validator for {@link CancelMessageResult}.
 */
export const cancelMessageResultSchema = messageSchemas.cancelMessageResultSchema;

/**
 * JSON body for `POST /token/generate`. Switch on `type`:
 * `TOP_UP_KWH` and `SET_POWER_LIMIT` require `payload`; `CLEAR_TAMPER` and
 * `CLEAR_CREDIT` do not.
 */
export type GenerateTokenRequest = z.infer<typeof messageSchemas.generateTokenSchema>;

/**
 * Runtime validator for {@link GenerateTokenRequest} (`POST /token/generate`).
 */
export const generateTokenSchema = messageSchemas.generateTokenSchema;

/**
 * Success body for `POST /token/generate` (`{ token }`).
 */
export type GenerateTokenResponse = z.infer<typeof responseSchemas.generateTokenResponseSchema>;

/**
 * Runtime validator for {@link GenerateTokenResponse}.
 */
export const generateTokenResponseSchema = responseSchemas.generateTokenResponseSchema;

/**
 * JSON body for `POST /plugin/provisioning`.
 * `operation` and `payload` are plugin-specific; this service only routes `pluginId`.
 */
export type PluginProvisioningRequest = z.infer<
  typeof messageSchemas.pluginProvisioningRequestSchema
>;

/**
 * Runtime validator for {@link PluginProvisioningRequest}.
 */
export const pluginProvisioningRequestSchema =
  messageSchemas.pluginProvisioningRequestSchema;

/**
 * Success body for `POST /plugin/provisioning`. `result` is plugin-specific.
 */
export type PluginProvisioningResponse = z.infer<
  typeof responseSchemas.pluginProvisioningResponseSchema
>;

/**
 * Runtime validator for {@link PluginProvisioningResponse}.
 */
export const pluginProvisioningResponseSchema =
  responseSchemas.pluginProvisioningResponseSchema;

/**
 * JSON this service POSTs to your event-webhook URL (not a route you call).
 *
 * Handle `message` ({@link WebhookMessage}): switch on `deliveryStatus`. Missing
 * `message.correlationId` means an unsolicited uplink (or an enqueue that omitted
 * one). Envelope also has `eventId` (stable across HTTP retries), `occurredAt`,
 * `pluginId`.
 *
 * Validate with {@link webhookEventSchema}.
 */
export type WebhookEvent = z.infer<typeof webhookEventSchemaSource>;

/**
 * `message` on {@link WebhookEvent} — the delivery snapshot your webhook handler
 * should switch on. Trimmed vs {@link DeviceMessageResponse} (no `priority`,
 * `pluginId`, `requestData`, or `deliveryQueueId`).
 */
export type WebhookMessage = WebhookEvent['message'];

/**
 * Runtime validator for {@link WebhookEvent}.
 */
export const webhookEventSchema = webhookEventSchemaSource;

/**
 * Error JSON on command-API `400` / `404`.
 * Schema failures may include {@link ValidationIssue} `issues`; other errors omit them.
 */
export type ErrorBody = z.infer<typeof responseSchemas.errorBodySchema>;

/**
 * Runtime validator for {@link ErrorBody}.
 */
export const errorBodySchema = responseSchemas.errorBodySchema;

/**
 * One field failure inside {@link ErrorBody} `issues` on a validation `400`.
 */
export type ValidationIssue = z.infer<typeof responseSchemas.validationIssueSchema>;

/**
 * Runtime validator for {@link ValidationIssue}.
 */
export const validationIssueSchema = responseSchemas.validationIssueSchema;
