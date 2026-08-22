/**
 * @fileoverview The engine's clock: one interval, gated on `engine.enabled` (ADR-002 §7).
 *
 * One cadence replaces the old 2 s timeout scan and the 5 s PULL poll, because under the
 * stage table both were the same question asked of different queues (ADR-008 §10). The
 * runner carries a re-entry guard per stage row, so a tick that outlives the interval
 * delays only the rows that are still busy.
 */

import type { LifecycleRunner } from './lifecycle/runner.js';
import { logger } from '../log.js';

/**
 * Engine tick interval.
 *
 * Bounds punctuality error at ±1 s, which is comfortably under the shortest wait in the
 * system (`retryBaseDelayMs`, 2000 ms) and matches `WEBHOOK_DRAIN_INTERVAL_MS`. The exact
 * alternative — sleep until the earliest due score — costs a recomputation on every insert
 * and buys nothing until punctuality matters more than simplicity (ADR-008 §10).
 */
export const ENGINE_TICK_INTERVAL_MS = 1_000;

/** Dependencies for {@link startEngineTimers}. */
export type StartEngineTimersOptions = {
  /** When false, no interval is started (ingest/inspect-only). */
  readonly enabled: boolean;
  readonly runner: LifecycleRunner;
  /** Override for tests. */
  readonly tickIntervalMs?: number;
};

/**
 * Start the engine tick when the engine is enabled.
 * Returns `{ stop }` to clear the interval (tests / shutdown).
 *
 * @param options - Enable flag, the stage runner, and an optional interval override
 */
export function startEngineTimers({
  enabled,
  runner,
  tickIntervalMs = ENGINE_TICK_INTERVAL_MS,
}: StartEngineTimersOptions): { stop(): void } {
  if (!enabled) {
    return { stop() { /* no-op */ } };
  }

  const handle = setInterval(() => {
    void runner.tick().catch((err: unknown) => {
      logger.error({ module: 'timers', err }, 'engine tick failed');
    });
  }, tickIntervalMs);

  return {
    stop() {
      clearInterval(handle);
    },
  };
}
