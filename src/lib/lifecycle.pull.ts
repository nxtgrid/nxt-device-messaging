/**
 * @fileoverview PULL pattern lifecycle management (polling-based, e.g. CALIN API V1/V2).
 *
 * Handles:
 * - Polling for status updates with age-based backoff
 * - Age-based timeout with permanent failure (no retry)
 *
 * Functions return data; side effects (publish, retryOrFail) are handled by the caller.
 *
 * PULL concurrency caps (`PULL_MAX_CONCURRENT_PER_GATEWAY` in legacy) are **not** here —
 * they belong to ADR-006 concurrency admission (Units 5–6 / plugin tuning).
 *
 * Max age and the poll-delay ladder are module defaults for now (D5: end state is plugin
 * `tuning`; do not grow interim `delivery.*` further in Unit 4).
 */

import { decodeTime } from 'ulid';
import { redisRepo } from './redis-repository/index.js';
import { redisKeys } from './redis-repository/keys.js';
import type { DeviceMessage, ParsedIncomingEvent } from './types.js';

/**
 * Maximum age for PULL awaiting-task messages before permanent failure (48 hours).
 * Interim module default — D5 moves this to plugin `tuning`.
 */
const PULL_PATTERN_MAX_MESSAGE_AGE_MS = 48 * 60 * 60 * 1000; // 172_800_000

/** Options passed through to {@link redisRepo.messageFullCleanup} (ADR-006 D2 interim). */
export type MessageFullCleanupOptions = {
  inFlightQueueKeys?: readonly string[];
  concurrencyRateLimitKey?: string;
};

/**
 * Interim structural minimum for PULL status polling (Unit 4).
 * Deleted at Unit 6 in favour of `DeviceMessagingPlugin` / `plugin.incoming`.
 */
export type PullIncoming = {
  fetchStatus(message: DeviceMessage): Promise<ParsedIncomingEvent | null>;
};

/** Result of polling: a parsed event tied to its queue. */
export type PollResult = {
  parsedEvent: ParsedIncomingEvent;
  queueKey: string;
};

/** Result of a PULL pattern timeout: a failed message ready to publish. */
export type PullTimeoutResult = {
  message: Partial<DeviceMessage>;
};

/**
 * Calculate the next poll delay based on message age.
 * Older messages get polled less frequently.
 *
 * Interim hardcoded ladder — D5: end state is plugin `tuning`.
 */
function getNextPollDelay(messageAgeMs: number): number {
  if (messageAgeMs < 20_000) return 10_000; // 0-20s old: wait 10s
  if (messageAgeMs < 50_000) return 15_000; // 20-50s old: wait 15s
  if (messageAgeMs < 90_000) return 20_000; // 50-90s old: wait 20s
  return 30_000; // 90s+: wait 30s (cap)
}

/**
 * Poll a PULL plugin's `queue_awaiting_task:{pluginId}` for due status updates.
 * Only polls messages whose "next poll time" (score) has passed.
 *
 * Returns parsed events for completed messages. Pending messages
 * have their next poll time updated internally.
 *
 * @param pluginId - Opaque plugin id (`queue_awaiting_task:{pluginId}`)
 * @param plugin - Plugin (or structural minimum with `fetchStatus`)
 * @returns Array of poll results to process
 */
export async function pollAwaitingTasksFor(
  pluginId: string,
  plugin: PullIncoming,
): Promise<PollResult[]> {
  const queueKey = redisKeys.queueAwaitingTask(pluginId);
  const messageIds = await redisRepo.getMessagesDueForPolling(queueKey);
  const results: PollResult[] = [];

  for (const messageId of messageIds) {
    const message = await redisRepo.getMessageById(messageId);
    // Guard: message might have been cleaned up or moved by reaper
    if (!message?.delivery_queue_id) continue;

    const parsedEvent = await plugin.fetchStatus(message);

    if (!parsedEvent) {
      // Still pending - update next poll time based on message age
      const now = Date.now();
      const messageAge = now - decodeTime(messageId);
      const nextPollAt = now + getNextPollDelay(messageAge);
      await redisRepo.updateNextPollTime(queueKey, messageId, nextPollAt);
      continue;
    }

    results.push({ parsedEvent, queueKey });
  }

  return results;
}

/**
 * Find PULL pattern messages that have exceeded their max age.
 * Cleans up timed-out messages and returns them for publishing.
 *
 * Caller supplies which PULL `pluginId`s to scan (Unit 5/6 get them from the registry).
 * Core does not hardcode which plugins are PULL.
 *
 * @param now - Current timestamp
 * @param pluginIds - PULL plugin ids whose awaiting-task queues to scan
 * @param cleanupOptions - Optional D2 cleanup seams (no key invention here)
 * @returns Array of failed messages to publish
 */
export async function getPullTimeouts(
  now: number,
  pluginIds: readonly string[],
  cleanupOptions?: MessageFullCleanupOptions,
): Promise<PullTimeoutResult[]> {
  const results: PullTimeoutResult[] = [];

  for (const pluginId of pluginIds) {
    const queueKey = redisKeys.queueAwaitingTask(pluginId);
    // @SCALE :: Loads all message IDs at once. Fine for current volume (~500 max),
    // but if scale increases, switch to batched ZRANGE with LIMIT (not ZSCAN, which
    // is unsafe when mutating the set during iteration via messageFullCleanup).
    const messageIds = await redisRepo.getAllMessageIdsInQueue(queueKey);

    for (const messageId of messageIds) {
      // Use ULID timestamp to calculate message age
      const messageAge = now - decodeTime(messageId);
      if (messageAge < PULL_PATTERN_MAX_MESSAGE_AGE_MS) continue;

      const message = await redisRepo.getMessageById(messageId);
      if (!message) continue;

      // Permanent failure - no retry for PULL pattern timeouts
      await redisRepo.messageFullCleanup(message, cleanupOptions);
      results.push({
        message: {
          ...message,
          delivery_status: 'DELIVERY_FAILED',
          failure_history: [
            {
              timestamp: new Date(now).toISOString(),
              status: 'DELIVERED_TO_NS',
              reason: 'Timed out waiting for remote task completion',
              isFinal: true,
            },
            ...(message.failure_history ?? []),
          ],
        },
      });
    }
  }

  return results;
}
