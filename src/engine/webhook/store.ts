/**
 * @fileoverview Redis persistence for outbound event-webhook notifications.
 *
 * Owns only `webhook:*` keys. Uses the shared Redis client (same DB as device
 * queues) but does not touch `device_message:*` / `queue:*`.
 *
 * HTTP delivery lives in a later chunk (`createWebhookService`).
 */

import type { Redis } from 'iovalkey';

import { webhookRedisKeys } from './keys.js';
import type { WebhookStoredRecord } from './types.js';

/** Max due members claimed per drain tick (same pragmatic batch as device queues). */
export const WEBHOOK_DRAIN_BATCH_SIZE = 50;

/**
 * Fail if a MULTI/EXEC reply is missing or any command errored.
 *
 * @param results - `exec()` reply
 * @param operation - Label for the error message
 */
function assertExecSucceeded(
  results: [Error | null, unknown][] | null,
  operation: string,
): void {
  if (results === null) {
    throw new Error(`[WEBHOOK STORE] ${ operation } aborted (MULTI/EXEC returned null)`);
  }
  for (const [ err ] of results) {
    if (err) {
      throw err instanceof Error
        ? err
        : new Error(`[WEBHOOK STORE] ${ operation } failed: ${ String(err) }`);
    }
  }
}

/**
 * Parse a stored JSON record; returns null if missing or malformed.
 *
 * @param raw - Redis string value
 */
export function parseWebhookStoredRecord(raw: string | null): WebhookStoredRecord | null {
  if (raw === null || raw === '') {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object'
      || parsed === null
      || !('event' in parsed)
      || !('attemptCount' in parsed)
    ) {
      return null;
    }
    return parsed as WebhookStoredRecord;
  }
  catch {
    return null;
  }
}

/** Redis operations for pending webhook notifications and the DLQ. */
export type WebhookStore = {
  /**
   * Persist a new notification and schedule its first attempt.
   *
   * @param record - Event + attempt metadata (`attemptCount` usually 0)
   * @param nextAttemptAtMs - Score for `webhook:pending` (unix ms; use `Date.now()` for immediate)
   */
  enqueue(record: WebhookStoredRecord, nextAttemptAtMs: number): Promise<void>;

  /**
   * Event ids due for delivery (`score <= now`), oldest-due first.
   *
   * @param nowMs - Current time (unix ms)
   * @param limit - Max ids (default {@link WEBHOOK_DRAIN_BATCH_SIZE})
   */
  listDueEventIds(nowMs: number, limit?: number): Promise<string[]>;

  /** Load a pending payload, or null if missing / unparseable. */
  getRecord(eventId: string): Promise<WebhookStoredRecord | null>;

  /**
   * Update payload and reschedule on the pending set (retry path).
   *
   * @param record - Updated record (same `eventId` in `event`)
   * @param nextAttemptAtMs - Next score for `webhook:pending`
   */
  reschedule(record: WebhookStoredRecord, nextAttemptAtMs: number): Promise<void>;

  /**
   * Successful delivery — drop pending membership and payload.
   *
   * @param eventId - Notification id
   */
  complete(eventId: string): Promise<void>;

  /**
   * Move to DLQ with TTL; remove from pending + payload.
   *
   * @param record - Final record (usually includes `lastError`)
   * @param ttlSeconds - `eventWebhook.deadLetterTtlSeconds`
   */
  deadLetter(record: WebhookStoredRecord, ttlSeconds: number): Promise<void>;
};

/** Dependencies for {@link createWebhookStore}. */
export type CreateWebhookStoreOptions = {
  readonly client: Redis;
};

/**
 * Factory for webhook Redis access (injected client — same instance as `redisRepo.client`).
 *
 * @param options - Redis client
 */
export function createWebhookStore(options: CreateWebhookStoreOptions): WebhookStore {
  const { client } = options;

  return {
    async enqueue(record, nextAttemptAtMs) {
      const eventId = record.event.eventId;
      const multi = client.multi();
      multi.set(webhookRedisKeys.payload(eventId), JSON.stringify(record));
      multi.zadd(webhookRedisKeys.pending(), nextAttemptAtMs, eventId);
      assertExecSucceeded(await multi.exec(), 'enqueue');
    },

    async listDueEventIds(nowMs, limit = WEBHOOK_DRAIN_BATCH_SIZE) {
      return client.zrangebyscore(
        webhookRedisKeys.pending(),
        '-inf',
        nowMs,
        'LIMIT',
        0,
        limit,
      );
    },

    async getRecord(eventId) {
      const raw = await client.get(webhookRedisKeys.payload(eventId));
      return parseWebhookStoredRecord(raw);
    },

    async reschedule(record, nextAttemptAtMs) {
      const eventId = record.event.eventId;
      const multi = client.multi();
      multi.set(webhookRedisKeys.payload(eventId), JSON.stringify(record));
      multi.zadd(webhookRedisKeys.pending(), nextAttemptAtMs, eventId);
      assertExecSucceeded(await multi.exec(), 'reschedule');
    },

    async complete(eventId) {
      const multi = client.multi();
      multi.zrem(webhookRedisKeys.pending(), eventId);
      multi.del(webhookRedisKeys.payload(eventId));
      assertExecSucceeded(await multi.exec(), 'complete');
    },

    async deadLetter(record, ttlSeconds) {
      const eventId = record.event.eventId;
      const multi = client.multi();
      multi.set(
        webhookRedisKeys.deadLetter(eventId),
        JSON.stringify(record),
        'EX',
        ttlSeconds,
      );
      multi.zrem(webhookRedisKeys.pending(), eventId);
      multi.del(webhookRedisKeys.payload(eventId));
      assertExecSucceeded(await multi.exec(), 'deadLetter');
    },
  };
}
