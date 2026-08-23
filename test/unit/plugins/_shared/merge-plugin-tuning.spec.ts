import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PLUGIN_TUNING,
  mergePluginTuning,
} from '#src/plugins/_shared/merge-plugin-tuning.js';

describe('DEFAULT_PLUGIN_TUNING', () => {
  it('pins the service-wide stage / poll defaults', () => {
    expect(DEFAULT_PLUGIN_TUNING).toEqual({
      nsInFlightTimeoutMs: 20_000,
      relayNodeInFlightTimeoutMs: 900_000,
      deviceInFlightTimeoutMs: 12_000,
      initialPollDelayMs: 10_000,
    });
  });
});

describe('mergePluginTuning', () => {
  it('returns core defaults when tuning and overrides are absent', () => {
    expect(mergePluginTuning({ id: 'p' })).toEqual(DEFAULT_PLUGIN_TUNING);
  });

  it('applies plugin overrides onto core defaults', () => {
    expect(mergePluginTuning({ id: 'p' }, { nsInFlightTimeoutMs: 40_000 })).toEqual({
      ...DEFAULT_PLUGIN_TUNING,
      nsInFlightTimeoutMs: 40_000,
    });
  });

  it('applies config over plugin overrides', () => {
    expect(mergePluginTuning(
      { id: 'p', tuning: { nsInFlightTimeoutMs: 15_000 } },
      { nsInFlightTimeoutMs: 40_000 },
    )).toEqual({
      ...DEFAULT_PLUGIN_TUNING,
      nsInFlightTimeoutMs: 15_000,
    });
  });

  it('merges partial config onto defaults', () => {
    expect(mergePluginTuning({
      id: 'p',
      tuning: { nsInFlightTimeoutMs: 15_000 },
    })).toEqual({
      ...DEFAULT_PLUGIN_TUNING,
      nsInFlightTimeoutMs: 15_000,
    });
  });

  it('rejects unknown keys and non-positive numbers', () => {
    expect(() => mergePluginTuning({
      id: 'p',
      tuning: { notAKnob: 1 },
    })).toThrow(/Invalid tuning for plugin "p"/);

    expect(() => mergePluginTuning({
      id: 'p',
      tuning: { initialPollDelayMs: 0 },
    })).toThrow(/Invalid tuning/);
  });
});
