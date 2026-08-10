/**
 * @fileoverview Redis key builders for outbound event-webhook state (ADR-003 §6).
 *
 * Same Redis DB as device-message queues; `webhook:*` prefix keeps the keyspace
 * visually and operationally separate from `device_message:*` / `queue:*`.
 *
 * Key paths are snake_case with `:` separators (repo Redis convention).
 */

export const webhookRedisKeys = {
  /**
   * Sorted set of pending notifications.
   * Members = `eventId`, score = `nextAttemptAt` (unix ms).
   */
  pending: (): string => 'webhook:pending',

  /**
   * JSON payload for a pending notification (`WebhookStoredRecord`).
   * Key: `webhook:payload:{eventId}`
   */
  payload: (eventId: string): string => `webhook:payload:${ eventId }`,

  /**
   * Dead-lettered payload after retries exhausted (TTL via SET EX).
   * Key: `webhook:dlq:{eventId}`
   */
  deadLetter: (eventId: string): string => `webhook:dlq:${ eventId }`,
} as const;
