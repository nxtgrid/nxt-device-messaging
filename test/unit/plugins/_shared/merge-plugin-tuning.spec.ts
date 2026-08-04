import { describe, expect, it } from 'vitest';

import { mergePluginTuning } from '#src/plugins/_shared/merge-plugin-tuning.js';
import type { PluginTuning } from '#src/plugins/plugin.interface.js';

const defaults: PluginTuning = {
  nsInFlightTimeoutMs: 20_000,
  relayNodeInFlightTimeoutMs: 900_000,
  deviceInFlightTimeoutMs: 12_000,
  initialPollDelayMs: 10_000,
};

describe('mergePluginTuning', () => {
  it('returns defaults when tuning is absent', () => {
    expect(mergePluginTuning(defaults, { id: 'p' })).toEqual(defaults);
  });

  it('merges partial overrides onto defaults', () => {
    expect(mergePluginTuning(defaults, {
      id: 'p',
      tuning: { nsInFlightTimeoutMs: 15_000 },
    })).toEqual({
      ...defaults,
      nsInFlightTimeoutMs: 15_000,
    });
  });

  it('rejects unknown keys and non-positive numbers', () => {
    expect(() => mergePluginTuning(defaults, {
      id: 'p',
      tuning: { notAKnob: 1 },
    })).toThrow(/Invalid tuning for plugin "p"/);

    expect(() => mergePluginTuning(defaults, {
      id: 'p',
      tuning: { initialPollDelayMs: 0 },
    })).toThrow(/Invalid tuning/);
  });
});
