/**
 * @fileoverview Outbound event-webhook messenger (ADR-003 §6).
 *
 * Always enqueues to Redis, then kicks the same private drain the timer uses.
 * Device engine never awaits HTTP. HMAC is a later chunk.
 */

import type { EventWebhookConfig } from '../../config/schema.js';
import type { DeviceMessage } from '../../lib/device-message/types.js';
import { calculateWebhookBackoffDelay } from './backoff.js';
import { buildWebhookEvent } from './build-event.js';
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
 * @param options - Config + Redis store
 */
export function createWebhookService(options: CreateWebhookServiceOptions): WebhookService {
  const { config, store } = options;

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

    let response: Response;
    try {
      response = await fetch(config.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(record.event),
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
