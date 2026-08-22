/**
 * @fileoverview Scrape-time Redis queue depths (ADR-005 §5). Read-only; no new keys.
 *
 * Stage keys are derived from `src/engine/lifecycle/stages.ts`, so a new stage shows
 * up here without an edit. Initial queues come from `queues_to_distribute_from`.
 */

import { enumerateStageKeys } from '../engine/lifecycle/stages.js';
import { webhookRedisKeys } from '../engine/webhook/keys.js';
import { redisKeys } from '../lib/redis-repository/keys.js';

/** One sorted-set cardinality to export as `device_messaging_queue_depth{queue}`. */
export type QueueDepth = {
  readonly queue: string;
  readonly depth: number;
};

/** Redis surface used by {@link collectQueueDepths} (no iovalkey types). */
export type QueueDepthRedis = {
  smembers(key: string): Promise<string[]>;
  pipeline(): QueueDepthPipeline;
};

type QueueDepthPipeline = {
  zcard(key: string): QueueDepthPipeline;
  exec(): Promise<[Error | null, unknown][] | null>;
};

/** The one key here that is not a stage: the outbound webhook's pending set. */
const WEBHOOK_PENDING_KEY = webhookRedisKeys.pending();

/**
 * SMEMBERS the distributor set, then one pipelined ZCARD for every stage queue
 * (derived from the table, per plugin), the webhook pending set, and each
 * initial-queue member.
 *
 * @param options - Redis client and enabled PULL plugin ids
 */
export async function collectQueueDepths(options: {
  readonly redis: QueueDepthRedis;
  readonly pullPluginIds: readonly string[];
}): Promise<readonly QueueDepth[]> {
  const stageKeys = enumerateStageKeys(options.pullPluginIds);
  const initialKeys = await options.redis.smembers(
    redisKeys.listOfInitialQueuesToDistributeFrom(),
  );

  const keys: string[] = [];
  const seen = new Set<string>();
  for (const key of [ ...stageKeys, WEBHOOK_PENDING_KEY, ...initialKeys ]) {
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    keys.push(key);
  }

  const pipeline = options.redis.pipeline();
  for (const key of keys) {
    pipeline.zcard(key);
  }
  const results = await pipeline.exec();
  if (results === null) {
    throw new Error('[metrics] queue-depth pipeline aborted');
  }

  return keys.map((queue, index) => {
    const pair = results[index];
    if (pair === undefined) {
      throw new Error(`[metrics] queue-depth missing result for ${ queue }`);
    }
    const [ err, raw ] = pair;
    if (err) {
      throw err;
    }
    const depth = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(depth)) {
      throw new Error(`[metrics] queue-depth non-numeric ZCARD for ${ queue }`);
    }
    return { queue, depth };
  });
}
