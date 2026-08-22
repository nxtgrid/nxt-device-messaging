import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LifecycleRunner } from '#src/engine/lifecycle/runner.js';
import {
  ENGINE_TICK_INTERVAL_MS,
  startEngineTimers,
} from '#src/engine/timers.js';

describe('startEngineTimers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing when engine is disabled', () => {
    vi.useFakeTimers();
    const tick = vi.fn(async () => undefined);

    const timers = startEngineTimers({
      enabled: false,
      runner: { tick } satisfies LifecycleRunner,
    });

    vi.advanceTimersByTime(ENGINE_TICK_INTERVAL_MS * 3);
    expect(tick).not.toHaveBeenCalled();
    timers.stop();
  });

  it('fires the engine tick on ENGINE_TICK_INTERVAL_MS when enabled', () => {
    vi.useFakeTimers();
    const tick = vi.fn(async () => undefined);

    const timers = startEngineTimers({
      enabled: true,
      runner: { tick } satisfies LifecycleRunner,
    });

    expect(tick).not.toHaveBeenCalled();

    vi.advanceTimersByTime(ENGINE_TICK_INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(ENGINE_TICK_INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(2);

    timers.stop();
    vi.advanceTimersByTime(ENGINE_TICK_INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(2);
  });
});
