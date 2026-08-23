/**
 * @fileoverview Redis port for ready-queue admission.
 *
 * Spacing locks and concurrency slots — the only Redis this port speaks.
 * `OutgoingService` is the only consumer (`_canAdmit`). Concurrency claim is in fetch-next Lua.
 */

import type { Redis } from 'iovalkey';

import { logger } from '../../log.js';
import { redisKeys } from './keys.js';

/** Redis operations for spacing locks and concurrency admission. */
export type AdmissionStore = {
  /**
   * Acquire a time-limited distributed lock on a queue.
   *
   * @param queueKey - Lock key for the queue
   * @param durationMs - Lock duration in milliseconds
   * @returns `'OK'` if lock acquired, `null` if already locked
   */
  lockQueueForTimeMs(queueKey: string, durationMs: number): Promise<string | null>;
  /**
   * How many messages are currently tracked in a concurrency set.
   *
   * @param concurrencyRateLimitKey - Opaque rate-limit set key
   */
  getConcurrencyRateLimitCount(concurrencyRateLimitKey: string): Promise<number>;
  /**
   * Drop members whose message hash no longer exists. Only call when the set
   * is at capacity.
   *
   * @param concurrencyRateLimitKey - Opaque rate-limit set key
   * @returns Live members remaining after cleanup
   */
  validateAndCleanConcurrencyRateLimit(
    concurrencyRateLimitKey: string,
  ): Promise<number>;
};

/** Dependencies for {@link createAdmissionStore}. */
export type CreateAdmissionStoreOptions = {
  readonly client: Redis;
};

/**
 * Factory for admission Redis access (injected client).
 *
 * @param options - Redis client (same instance as the rest of the process)
 */
export function createAdmissionStore(
  options: CreateAdmissionStoreOptions,
): AdmissionStore {
  const { client } = options;

  return {
    lockQueueForTimeMs(queueKey, durationMs) {
      return client.set(queueKey, 'locked', 'PX', durationMs, 'NX');
    },

    getConcurrencyRateLimitCount(concurrencyRateLimitKey) {
      return client.scard(concurrencyRateLimitKey);
    },

    async validateAndCleanConcurrencyRateLimit(concurrencyRateLimitKey) {
      const members = await client.smembers(concurrencyRateLimitKey);
      if (members.length === 0) return 0;

      const existsPipeline = client.pipeline();
      for (const messageId of members) {
        existsPipeline.exists(redisKeys.message(messageId));
      }

      const results = await existsPipeline.exec();
      if (!results) return members.length;
      const deadMembers = members.filter((_member, idx) => {
        const [ err, exists ] = results[idx] as unknown as [unknown, number];
        return !err && exists === 0;
      });

      if (deadMembers.length > 0) {
        await client.srem(concurrencyRateLimitKey, ...deadMembers);
        logger.warn({
          module: 'redis',
          deadCount: deadMembers.length,
          concurrencyRateLimitKey,
        }, 'cleaned dead concurrency rate-limit entries');
      }

      return members.length - deadMembers.length;
    },
  };
}
