import { PhaseEnum } from '../device-message/types.js';

/**
 * Redis key builders for the device-message delivery pipeline.
 *
 * Casing convention (locked):
 * - **Key paths + Lua locals** — snake_case (`device_message:…`, `idx:correlation_id:…`)
 * - **Hash fields** (serialized domain) — camelCase (`deliveryStatus`, `correlationId`, …)
 * - Segment separator is `:` (not `#`).
 *
 * Other notes:
 * - Unit 2 intentionally omits `queueInitial()` (ADR-006): initial queue selection
 *   is owned by plugins via `initialQueueKey` → `buildInitialQueueKey`.
 * - Queue key shape: `queue:{pluginId}:{kind}:{id}` (ADR-006).
 *   Core must not parse queue keys for policy.
 * - Concurrency rate-limit set keys are plugin vocabulary (ADR-006 `trackKey`); core
 *   helpers take the opaque key string — no `gateway` / `unassigned` builders here.
 */

export const redisKeys = {
  /**
   * Main entity hash.
   * Key: `device_message:{messageId}`
   */
  message: (messageId: string): string => `device_message:${ messageId }`,

  /**
   * Set of active initial queues (sorted sets) that currently have work.
   * Key: `queues_to_distribute_from`
   */
  listOfInitialQueuesToDistributeFrom: (): string => 'queues_to_distribute_from',

  /**
   * Distributed lock for a queue (spacing admission strategy).
   * Key: `lock_queue:{queueKey}`
   */
  lockForQueue: (toLock: string): string => `lock_queue:${ toLock }`,

  /**
   * Awaiting-task queue for PULL-style plugins.
   * Key: `queue_awaiting_task:{pluginId}`
   */
  queueAwaitingTask: (pluginId: string): string => `queue_awaiting_task:${ pluginId }`,

  /**
   * Index for correlation id with optional phase suffix.
   * Base:  `idx:correlation_id:{correlationId}`
   * Phase: `idx:correlation_id:{correlationId}_ph{phase}`
   */
  indexCorrelationId: (correlationId: string, phase?: PhaseEnum): string => {
    const phaseSuffix = phase ? `_ph${ phase }` : '';
    return `idx:correlation_id:${ correlationId }${ phaseSuffix }`;
  },

  /** Index for lookup by external delivery reference. */
  indexExternalDeliveryId: (externalDeliveryId: string): string =>
    `idx:external_delivery_id:${ externalDeliveryId }`,
};
