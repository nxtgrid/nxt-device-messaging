/**
 * @fileoverview Interval timers for the delivery engine (Unit 5.6).
 *
 * Gated on `engine.enabled` (ADR-002 §7). No overlap guard — a tick that outlives
 * its interval may re-enter (deliberate; matches historical behaviour).
 */

import type { IncomingService } from './incoming.js';
import type { OutgoingService } from './outgoing.js';

/** Resolution-cycle interval. */
export const RESOLUTION_CYCLE_INTERVAL_MS = 2_000;

/** PULL poll interval. */
export const POLL_PULL_INTERVAL_MS = 5_000;

/** Dependencies for {@link startEngineTimers}. */
export type StartEngineTimersOptions = {
  /** When false, no intervals are started (ingest/inspect-only). */
  readonly enabled: boolean;
  readonly outgoingService: OutgoingService;
  readonly incomingService: IncomingService;
  /** Override for tests. */
  readonly resolutionCycleIntervalMs?: number;
  /** Override for tests. */
  readonly pollPullIntervalMs?: number;
};

/**
 * Start resolution-cycle + PULL-poll intervals when the engine is enabled.
 * Returns `{ stop }` to clear both intervals (tests / shutdown).
 *
 * @param options - Enable flag, peer services, and optional interval overrides
 */
export function startEngineTimers({
  enabled,
  outgoingService,
  incomingService,
  resolutionCycleIntervalMs = RESOLUTION_CYCLE_INTERVAL_MS,
  pollPullIntervalMs = POLL_PULL_INTERVAL_MS,
}: StartEngineTimersOptions): { stop(): void } {
  if (!enabled) {
    return { stop() { /* no-op */ } };
  }

  const resolutionHandle = setInterval(() => {
    void outgoingService.runMessageResolutionCycle().catch(err => {
      console.error('[engine] runMessageResolutionCycle failed', err);
    });
  }, resolutionCycleIntervalMs);

  const pollHandle = setInterval(() => {
    void incomingService.pollPullPlugins().catch(err => {
      console.error('[engine] pollPullPlugins failed', err);
    });
  }, pollPullIntervalMs);

  return {
    stop() {
      clearInterval(resolutionHandle);
      clearInterval(pollHandle);
    },
  };
}
