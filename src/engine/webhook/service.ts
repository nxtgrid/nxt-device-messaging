/**
 * @fileoverview Outbound event-webhook messenger (ADR-003 §6).
 *
 * Always enqueues to Redis, then kicks the same private drain the timer uses.
 * Device engine never awaits HTTP. Opt-in HMAC when `signingSecret` is set.
 */

import type { EventWebhookConfig } from '../../config/schema.js';
import type { DeviceMessage } from '../../lib/device-message/types.js';
import { calculateWebhookBackoffDelay } from './backoff.js';
import { buildWebhookEvent } from './build-event.js';
import {
  formatWebhookSignatureHeader,
  signWebhookBody,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
} from './sign.js';
import type { WebhookStore } from './store.js';
import type { WebhookStoredRecord } from './types.js';

/** Default timer interval for draining due webhook notifications. */
export const WEBHOOK_DRAIN_INTERVAL_MS = 1_000;

/** How long a claimed pending member is leased away from other drain ticks. */
const CLAIM_LEASE_MS = 60_000;

export type WebhookService = {
  /**
   * Build event, store in Redis, fire-and-forget drain (same path as the timer).
   * Drops (warn) when required fields are missing — never throws to the engine.
   */
  storeAndEmit(message: Partial<DeviceMessage>): void;
  /** Start the drain interval; `{ stop }` for tests / shutdown. */
  startTimers(options?: { readonly intervalMs?: number }): { stop(): void };
};

export type CreateWebhookServiceOptions = {
  readonly config: EventWebhookConfig;
  readonly store: WebhookStore;
  /**
   * When non-empty, POSTs include HMAC headers (ADR-003 §6).
   * From `DEVICE_MESSAGING_WEBHOOK_SECRET` at the composition root.
   */
  readonly signingSecret?: string;
};

/**
 * Whether an HTTP status should be retried (ADR-003 §6).
 *
 * @param status - Response status code
 */
export function isRetryableWebhookStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Factory for the outbound webhook messenger.
 *
 * @param options - Config, Redis store, optional signing secret
 */
export function createWebhookService(options: CreateWebhookServiceOptions): WebhookService {
  const { config, store, signingSecret } = options;
  const secret = signingSecret !== undefined && signingSecret !== ''
    ? signingSecret
    : undefined;

  /** Serialize overlapping drain kicks (timer + storeAndEmit) in-process. */
  let drainChain: Promise<void> = Promise.resolve();

  function storeAndEmit(message: Partial<DeviceMessage>): void {
    const built = buildWebhookEvent(message);
    if (!built.ok) {
      console.warn(`[webhook] drop storeAndEmit: ${ built.reason }`);
      return;
    }

    const record: WebhookStoredRecord = {
      event: built.event,
      attemptCount: 0,
    };

    void store.enqueue(record, Date.now())
      .then(() => _drainDue())
      .catch(err => {
        console.error('[webhook] enqueue/kick failed', err);
      });
  }

  function _drainDue(): Promise<void> {
    drainChain = drainChain
      .then(() => _drainOnce())
      .catch(err => {
        console.error('[webhook] drain failed', err);
      });
    return drainChain;
  }

  async function _drainOnce(): Promise<void> {
    const dueIds = await store.listDueEventIds(Date.now());
    for (const eventId of dueIds) {
      await _deliverOne(eventId);
    }
  }

  async function _deliverOne(eventId: string): Promise<void> {
    const record = await store.getRecord(eventId);
    if (!record) {
      await store.complete(eventId);
      return;
    }

    // Lease: push score forward so a concurrent tick skips this id while we POST.
    await store.reschedule(record, Date.now() + CLAIM_LEASE_MS);

    const rawBody = JSON.stringify(record.event);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (secret !== undefined) {
      headers[WEBHOOK_SIGNATURE_HEADER] = formatWebhookSignatureHeader(
        signWebhookBody(secret, rawBody),
      );
      headers[WEBHOOK_EVENT_ID_HEADER] = record.event.eventId;
    }

    let response: Response;
    try {
      response = await fetch(config.url, {
        method: 'POST',
        headers,
        body: rawBody,
      });
    }
    catch (err) {
      await _onFailure(record, err instanceof Error ? err.message : String(err));
      return;
    }

    if (response.ok) {
      await store.complete(eventId);
      return;
    }

    const errorText = `HTTP ${ response.status }`;
    if (!isRetryableWebhookStatus(response.status)) {
      await store.deadLetter(
        { ...record, lastError: errorText },
        config.deadLetterTtlSeconds,
      );
      return;
    }

    await _onFailure(record, errorText);
  }

  async function _onFailure(
    record: WebhookStoredRecord,
    lastError: string,
  ): Promise<void> {
    const attemptCount = record.attemptCount + 1;
    const updated: WebhookStoredRecord = { ...record, attemptCount, lastError };

    if (attemptCount >= config.maxAttempts) {
      await store.deadLetter(updated, config.deadLetterTtlSeconds);
      console.error(
        '[webhook] exhausted retries → DLQ',
        {
          eventId: record.event.eventId,
          correlationId: record.event.message.correlationId,
          lastError,
        },
      );
      return;
    }

    const delayMs = calculateWebhookBackoffDelay(attemptCount, config);
    await store.reschedule(updated, Date.now() + delayMs);
  }

  function startTimers(
    timerOptions: { readonly intervalMs?: number } = {},
  ): { stop(): void } {
    const intervalMs = timerOptions.intervalMs ?? WEBHOOK_DRAIN_INTERVAL_MS;
    const handle = setInterval(() => {
      void _drainDue();
    }, intervalMs);
    return {
      stop() {
        clearInterval(handle);
      },
    };
  }

  return { storeAndEmit, startTimers };
}
