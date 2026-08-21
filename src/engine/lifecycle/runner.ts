/**
 * @fileoverview The one loop that drives the stage table (ADR-008 §5, §10).
 *
 * Every stage queue is a sorted set scored by *the time the engine should next pay
 * attention to a member*, so draining one is the same work whatever the stage means: take
 * what is due, load it, ask the row's action what happened, then either write a new score
 * or remove the member.
 *
 * Those last two obligations live here and nowhere else. A message id whose hash is gone
 * is scrubbed by this loop (A1), and a member that is still waiting always leaves with a
 * new score (A2) — including when its action threw, which is why a vendor outage cannot
 * strand a queue.
 */

import { decodeTime } from 'ulid';

import { redisRepo } from '../../lib/redis-repository/index.js';
import type { DeviceMessage } from '../../lib/device-message/types.js';
import { logger } from '../../log.js';
import type { DeliveryPlugin } from '../../plugins/plugin.interface.js';
import type { PluginRegistry } from '../../plugins/registry.js';
import type { StageMoves } from './moves.js';
import { enumerateStageQueues } from './stages.js';
import type { StageActions, StageOutcome, StageQueue } from './types.js';

/** The engine's single periodic unit of work. */
export type LifecycleRunner = {
  /**
   * Drive every stage queue once. Rows run concurrently; members within a row run in
   * sequence. Never rejects — a failing row is logged and the others still finish.
   */
  tick(): Promise<void>;
};

/** Dependencies for {@link createLifecycleRunner}. */
export type CreateLifecycleRunnerOptions = {
  readonly registry: PluginRegistry;
  readonly actions: StageActions;
  readonly moves: StageMoves;
  /**
   * Ready-queue distribution. Not a stage (ADR-008 §2) but the same cadence, so the tick
   * kicks it once at the end — fire-and-forget, same as before the stage table.
   */
  readonly distribute?: () => Promise<void>;
};

/**
 * Factory for the stage runner.
 *
 * @param options - Registry, the stage actions, stage moves, optional distribute kick
 */
export function createLifecycleRunner(
  options: CreateLifecycleRunnerOptions,
): LifecycleRunner {
  const { registry, actions, moves, distribute } = options;

  /** Queue keys with a drain still in progress — one guard per row, not one per tick. */
  const draining = new Set<string>();

  /**
   * Run a row's action, converting a throw into "still waiting".
   *
   * A vendor call that fails is not evidence about the message, so the member keeps its
   * place and is tried again at the row's normal wait. Actions are safe to re-run: every
   * stage move is ZREM-gated in Lua.
   *
   * @param queue - The stage queue being drained
   * @param message - The due message
   * @param plugin - Its owning plugin
   * @param messageAgeMs - Age from the ULID
   */
  async function _act(
    queue: StageQueue,
    message: DeviceMessage,
    plugin: DeliveryPlugin,
    messageAgeMs: number,
  ): Promise<StageOutcome> {
    try {
      return await actions[queue.stage.name]({
        stage: queue.stage,
        queueKey: queue.key,
        message,
        plugin,
        messageAgeMs,
      });
    }
    catch (err) {
      logger.error({
        module: 'lifecycle',
        err,
        stage: queue.stage.name,
        messageId: message.id,
      }, 'stage action threw; rescheduling');
      return 'rescheduled';
    }
  }

  /**
   * Drain the members of one stage queue that are due at `now`.
   *
   * @param queue - Stage and its concrete Redis key
   * @param now - The tick's clock reading, shared by every row
   */
  async function _drain(queue: StageQueue, now: number): Promise<void> {
    const dueIds = await redisRepo.getExpiredMessagesInQueue(queue.key, now);

    for (const messageId of dueIds) {
      const message = await redisRepo.getMessageById(messageId);
      if (!message) {
        await redisRepo.removeMessageFromQueue(queue.key, messageId);
        continue;
      }

      const plugin = registry.get(message.pluginId);
      if (!plugin || plugin.deliveryPattern === 'NONE') {
        logger.warn({
          module: 'lifecycle',
          messageId,
          pluginId: message.pluginId,
          stage: queue.stage.name,
        }, 'member of a stage whose plugin is not a registered delivery plugin, removing');
        await redisRepo.removeMessageFromQueue(queue.key, messageId);
        continue;
      }

      const messageAgeMs = now - decodeTime(messageId);
      const outcome = await _act(queue, message, plugin, messageAgeMs);

      if (outcome === 'orphaned') {
        await redisRepo.removeMessageFromQueue(queue.key, messageId);
        continue;
      }

      if (outcome === 'rescheduled') {
        await moves.reschedule({ stage: queue.stage, message, messageAgeMs, plugin });
      }
    }
  }

  return {
    async tick(): Promise<void> {
      const now = Date.now();
      const pullPluginIds = registry.getByDeliveryPattern('PULL').map(plugin => plugin.id);

      await Promise.all(enumerateStageQueues(pullPluginIds).map(async queue => {
        // Rows are independent, so a slow vendor poll delays its own stage and no other.
        if (draining.has(queue.key)) return;
        draining.add(queue.key);

        try {
          await _drain(queue, now);
        }
        catch (err) {
          logger.error(
            { module: 'lifecycle', err, stage: queue.stage.name, queueKey: queue.key },
            'stage drain failed',
          );
        }
        finally {
          draining.delete(queue.key);
        }
      }));

      if (distribute) {
        void distribute().catch(err => {
          logger.error({ module: 'lifecycle', err }, 'distribute failed');
        });
      }
    },
  };
}
