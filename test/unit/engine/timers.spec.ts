import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IncomingService } from '#src/engine/incoming.js';
import type { OutgoingService } from '#src/engine/outgoing.js';
import {
  POLL_PULL_INTERVAL_MS,
  RESOLUTION_CYCLE_INTERVAL_MS,
  startEngineTimers,
} from '#src/engine/timers.js';

describe('startEngineTimers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing when engine is disabled', () => {
    vi.useFakeTimers();
    const runMessageResolutionCycle = vi.fn(async () => undefined);
    const pollPullPlugins = vi.fn(async () => undefined);

    const timers = startEngineTimers({
      enabled: false,
      outgoingService: { runMessageResolutionCycle } as unknown as OutgoingService,
      incomingService: { pollPullPlugins } as unknown as IncomingService,
    });

    vi.advanceTimersByTime(RESOLUTION_CYCLE_INTERVAL_MS * 3);
    expect(runMessageResolutionCycle).not.toHaveBeenCalled();
    expect(pollPullPlugins).not.toHaveBeenCalled();
    timers.stop();
  });

  it('fires resolution cycle and poll on their intervals when enabled', () => {
    vi.useFakeTimers();
    const runMessageResolutionCycle = vi.fn(async () => undefined);
    const pollPullPlugins = vi.fn(async () => undefined);

    const timers = startEngineTimers({
      enabled: true,
      outgoingService: { runMessageResolutionCycle } as unknown as OutgoingService,
      incomingService: { pollPullPlugins } as unknown as IncomingService,
    });

    expect(runMessageResolutionCycle).not.toHaveBeenCalled();
    expect(pollPullPlugins).not.toHaveBeenCalled();

    const resolutionTicksAtFirstPoll = Math.floor(
      POLL_PULL_INTERVAL_MS / RESOLUTION_CYCLE_INTERVAL_MS,
    );

    vi.advanceTimersByTime(RESOLUTION_CYCLE_INTERVAL_MS);
    expect(runMessageResolutionCycle).toHaveBeenCalledTimes(1);
    expect(pollPullPlugins).not.toHaveBeenCalled();

    vi.advanceTimersByTime(POLL_PULL_INTERVAL_MS - RESOLUTION_CYCLE_INTERVAL_MS);
    expect(pollPullPlugins).toHaveBeenCalledTimes(1);
    expect(runMessageResolutionCycle).toHaveBeenCalledTimes(resolutionTicksAtFirstPoll);

    timers.stop();
    vi.advanceTimersByTime(POLL_PULL_INTERVAL_MS);
    expect(runMessageResolutionCycle).toHaveBeenCalledTimes(resolutionTicksAtFirstPoll);
    expect(pollPullPlugins).toHaveBeenCalledTimes(1);
  });
});
