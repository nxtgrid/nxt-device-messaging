/**
 * @fileoverview Build a {@link WebhookEvent} from a partial device message (ADR-003 §6).
 */

import { ulid } from 'ulid';

import { omitInternalFields } from '../../lib/device-message/omit-internal-fields.js';
import type { DeviceMessage } from '../../lib/device-message/types.js';
import type { WebhookEvent, WebhookMessagePayload } from './types.js';

export type BuildWebhookEventResult =
  | { readonly ok: true; readonly event: WebhookEvent }
  | { readonly ok: false; readonly reason: string };

/**
 * Trim a partial device message into a webhook event.
 * Requires `pluginId`, `deliveryStatus`, and `device` (adopter contract).
 *
 * @param message - Partial / full device message from an engine emit site
 * @param occurredAt - ISO timestamp (injectable for tests)
 * @param eventId - ULID (injectable for tests)
 */
export function buildWebhookEvent(
  message: Partial<DeviceMessage>,
  occurredAt: string = new Date().toISOString(),
  eventId: string = ulid(),
): BuildWebhookEventResult {
  const trimmed = omitInternalFields(message);

  if (!trimmed.pluginId) {
    return { ok: false, reason: 'missing pluginId' };
  }
  if (!trimmed.deliveryStatus) {
    return { ok: false, reason: 'missing deliveryStatus' };
  }
  if (!trimmed.device) {
    return { ok: false, reason: 'missing device' };
  }

  const payload: WebhookMessagePayload = {
    deliveryStatus: trimmed.deliveryStatus,
    device: trimmed.device,
    ...(trimmed.id !== undefined && { id: trimmed.id }),
    ...(trimmed.correlationId !== undefined && { correlationId: trimmed.correlationId }),
    ...(trimmed.commandType !== undefined && { commandType: trimmed.commandType }),
    ...(trimmed.phase !== undefined && { phase: trimmed.phase }),
    ...(trimmed.response !== undefined && { response: trimmed.response }),
    ...(trimmed.failureHistory !== undefined && { failureHistory: trimmed.failureHistory }),
    ...(trimmed.unsolicited !== undefined && { unsolicited: trimmed.unsolicited }),
  };

  return {
    ok: true,
    event: {
      eventId,
      occurredAt,
      pluginId: trimmed.pluginId,
      message: payload,
    },
  };
}
