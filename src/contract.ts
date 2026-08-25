/**
 * @fileoverview Adopter-facing HTTP and webhook wire types.
 *
 * Allowlist for a future publishable contract package. Engine-only types
 * (`DeviceMessage`, `FailureContext`, `ParsedIncomingEvent`, Redis records)
 * are not exported. Ingress path params are vendor→service, not this barrel.
 */

import type { z } from 'zod';

import type { webhookEventSchema } from './engine/webhook/event-schema.js';
import type {
  errorBodySchema,
  generateTokenResponseSchema,
  pluginProvisioningResponseSchema,
  validationIssueSchema,
} from './http/response-schemas.js';
import type {
  cancelManyBodySchema,
  cancelOneBodySchema,
} from './lib/device-message/schemas.js';

export type {
  CancelMessageResult,
  CommandType,
  ControlCommandType,
  CreateDeviceMessage,
  DeviceMessageDeliveryStatus,
  DeviceMessageDevice,
  DeviceMessageResponse,
  DeviceType,
  EnqueueableCommandType,
  FailureReason,
  GenerateTokenRequest,
  GenerateTokenType,
  MessageResponse,
  MessageResponseStatus,
  PhaseEnum,
  PhaseSpecificReadCommandType,
  PluginId,
  PluginProvisioningRequest,
  ReadCommandType,
  RelayNodeInfo,
  SetDatePayload,
  SetTimePayload,
  TokenCommandType,
  UnsolicitedCommandType,
  WebhookMessagePayload,
  WriteCommandType,
} from './lib/device-message/types.js';

export type { CorrelationIdParams } from './http/message-params.js';

/** `POST /message/cancel` body. */
export type CancelOneBody = z.infer<typeof cancelOneBodySchema>;

/** `POST /messages/cancel` body. */
export type CancelManyBody = z.infer<typeof cancelManyBodySchema>;

/** `POST /token/generate` success body. */
export type GenerateTokenResponse = z.infer<typeof generateTokenResponseSchema>;

/** `POST /plugin/provisioning` success body. */
export type PluginProvisioningResponse = z.infer<
  typeof pluginProvisioningResponseSchema
>;

/** Command-API error payload (400 / 404). */
export type ErrorBody = z.infer<typeof errorBodySchema>;

/** One Zod field failure on a 400 with `issues`. */
export type ValidationIssue = z.infer<typeof validationIssueSchema>;

/** Outbound webhook POST body (this service → adopter). */
export type WebhookEvent = z.infer<typeof webhookEventSchema>;
