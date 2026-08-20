/**
 * @fileoverview Find (and purge) every Redis key that still references a message.
 *
 * Cleanup completeness is otherwise untestable: each spec would hand-list the keys
 * it happens to remember, which is how the production cleanup list and the metrics
 * stage list drifted apart in the first place. One enumeration, used by every spec.
 *
 * Uses `KEYS` for the dynamic families (initial queues, awaiting-task, rate-limit
 * sets). That is a full keyspace scan — fine against a small test database, not
 * something to copy into `src/`.
 */

import { QUEUE_NS_KEY, QUEUE_RETRY_KEY } from '#src/lib/queue-moving.js';
import { QUEUE_DEVICE_KEY, QUEUE_RELAY_NODE_KEY } from '#src/lib/queue-moving.push.js';
import type { PhaseEnum } from '#src/lib/device-message/types.js';
import { redisKeys } from '#src/lib/redis-repository/keys.js';
import { redisRepo } from '#src/lib/redis-repository/index.js';

/** Fixed-name stage queues, from the production constants rather than literals. */
const STAGE_QUEUE_KEYS = [
  QUEUE_NS_KEY,
  QUEUE_RELAY_NODE_KEY,
  QUEUE_DEVICE_KEY,
  QUEUE_RETRY_KEY,
] as const;

const AWAITING_TASK_PATTERN = 'queue_awaiting_task:*';
const INITIAL_QUEUE_PATTERN = 'queue:*';
const RATE_LIMIT_PATTERN = 'rate_limit:*';

/** Correlation index phases to probe (base index plus the three-phase suffixes). */
const INDEX_PHASES: ReadonlyArray<PhaseEnum | undefined> = [ undefined, 'A', 'B', 'C' ];

/** Identity of a message beyond its ULID, for the keys indexed by other values. */
export type MessageIdentity = {
  readonly correlationId?: string;
  readonly deliveryQueueId?: string;
};

/** Every sorted-set key that could hold a message id as a member. */
async function allQueueKeys(): Promise<string[]> {
  const client = redisRepo.client;
  const [ awaitingTask, initial ] = await Promise.all([
    client.keys(AWAITING_TASK_PATTERN),
    client.keys(INITIAL_QUEUE_PATTERN),
  ]);
  return [ ...STAGE_QUEUE_KEYS, ...awaitingTask, ...initial ];
}

function indexKeysFor(identity: MessageIdentity): string[] {
  const keys: string[] = [];
  if (identity.correlationId !== undefined) {
    for (const phase of INDEX_PHASES) {
      keys.push(redisKeys.indexCorrelationId(identity.correlationId, phase));
    }
  }
  if (identity.deliveryQueueId !== undefined && identity.deliveryQueueId !== '') {
    keys.push(redisKeys.indexExternalDeliveryId(identity.deliveryQueueId));
  }
  return keys;
}

/**
 * Every key that still references `messageId`, sorted.
 *
 * An empty array means the message left no trace: the assertion for any terminal
 * path. Index keys are only probed when the matching identity field is supplied,
 * because they are keyed by correlation / external id rather than by ULID.
 *
 * @param messageId - Message ULID
 * @param identity - Correlation and external delivery ids, when the test knows them
 */
export async function findMessageReferences(
  messageId: string,
  identity: MessageIdentity = {},
): Promise<string[]> {
  const client = redisRepo.client;
  const found: string[] = [];

  const messageKey = redisKeys.message(messageId);
  if (await client.exists(messageKey) === 1) found.push(messageKey);

  for (const queueKey of await allQueueKeys()) {
    if (await client.zscore(queueKey, messageId) !== null) found.push(queueKey);
  }

  for (const rateLimitKey of await client.keys(RATE_LIMIT_PATTERN)) {
    if (await client.sismember(rateLimitKey, messageId) === 1) found.push(rateLimitKey);
  }

  for (const indexKey of indexKeysFor(identity)) {
    if (await client.exists(indexKey) === 1) found.push(indexKey);
  }

  return found.sort();
}

/**
 * Remove every trace of `messageId`, whatever state it is in.
 *
 * For `afterEach`: a spec that fails mid-flight must not leave members behind for
 * the next file, because the stage queues are global.
 *
 * @param messageId - Message ULID
 * @param identity - Correlation and external delivery ids, when the test knows them
 */
export async function purgeMessageReferences(
  messageId: string,
  identity: MessageIdentity = {},
): Promise<void> {
  const client = redisRepo.client;
  const multi = client.multi();

  multi.del(redisKeys.message(messageId));
  for (const queueKey of await allQueueKeys()) {
    multi.zrem(queueKey, messageId);
  }
  for (const rateLimitKey of await client.keys(RATE_LIMIT_PATTERN)) {
    multi.srem(rateLimitKey, messageId);
  }
  for (const indexKey of indexKeysFor(identity)) {
    multi.del(indexKey);
  }

  await multi.exec();
}

/**
 * Delete external-delivery-id indexes matching a prefix.
 *
 * These are keyed by the vendor's id, not the message ULID, and carry the seven-day
 * message TTL — so a spec that generates them cannot clean them up by message id and
 * would otherwise litter a long-lived dev Valkey.
 *
 * @param prefix - External delivery id prefix (the programmable plugin emits `ext-`)
 */
export async function purgeExternalDeliveryIndexes(prefix: string): Promise<void> {
  const client = redisRepo.client;
  const keys = await client.keys(redisKeys.indexExternalDeliveryId(`${ prefix }*`));
  if (keys.length > 0) await client.del(...keys);
}

/**
 * Drop an initial queue and its distribute bookkeeping.
 *
 * @param queueKey - Initial-queue Redis key the spec enqueued into
 */
export async function purgeInitialQueue(queueKey: string): Promise<void> {
  const client = redisRepo.client;
  const multi = client.multi();
  multi.del(queueKey);
  multi.del(redisKeys.lockForQueue(queueKey));
  multi.srem(redisKeys.listOfInitialQueuesToDistributeFrom(), queueKey);
  await multi.exec();
}
