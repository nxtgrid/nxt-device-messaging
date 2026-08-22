/**
 * @fileoverview Shared config `plugins[].tuning` merge (ADR-002 §5 / D5 / C4).
 *
 * Core owns the default {@link PluginTuning}. Plugins call
 * {@link mergePluginTuning} and pass only deltas. The JSON artifact may
 * override any key. Unknown keys fail at construct.
 */

import { z } from 'zod';

import type { DeviceMessagingConfig } from '../../config/schema.js';
import type { PluginTuning } from '../plugin.interface.js';

type PluginConfigEntry = DeviceMessagingConfig['plugins'][number];

/**
 * Service-wide default stage timeouts / first-poll delay.
 *
 * No first-party plugin currently differs. Pass a delta to
 * {@link mergePluginTuning} when one does.
 */
export const DEFAULT_PLUGIN_TUNING: PluginTuning = {
  nsInFlightTimeoutMs: 20_000,
  relayNodeInFlightTimeoutMs: 900_000,
  deviceInFlightTimeoutMs: 12_000,
  initialPollDelayMs: 10_000,
};

/** Partial override shape for `plugins[].tuning` (unknown keys rejected). */
const tuningOverrideSchema = z.object({
  nsInFlightTimeoutMs: z.number().int().positive().optional(),
  relayNodeInFlightTimeoutMs: z.number().int().positive().optional(),
  deviceInFlightTimeoutMs: z.number().int().positive().optional(),
  initialPollDelayMs: z.number().int().positive().optional(),
}).strict();

/**
 * Merge core defaults, optional plugin deltas, and config `plugins[].tuning`.
 *
 * @param entry - Config `plugins[]` entry (`id` used in error text)
 * @param overrides - Plugin-owned deltas; omit when the core defaults stand
 * @returns Merged tuning
 * @throws If `entry.tuning` has unknown keys or invalid values
 */
export function mergePluginTuning(
  entry: PluginConfigEntry,
  overrides?: Partial<PluginTuning>,
): PluginTuning {
  const defaults: PluginTuning = { ...DEFAULT_PLUGIN_TUNING, ...overrides };

  if (entry.tuning === undefined) {
    return defaults;
  }

  const parsed = tuningOverrideSchema.safeParse(entry.tuning);
  if (!parsed.success) {
    const detail = parsed.error.issues.map(issue => issue.message).join('; ');
    throw new Error(`Invalid tuning for plugin "${ entry.id }": ${ detail }`);
  }

  return { ...defaults, ...parsed.data };
}
