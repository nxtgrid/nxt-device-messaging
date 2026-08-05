/**
 * @fileoverview Shared config `plugins[].tuning` merge (ADR-002 §5 / D5).
 *
 * Plugins declare defaults in code; the JSON artifact may override any
 * {@link PluginTuning} key. Unknown keys fail at construct.
 */

import { z } from 'zod';

import type { DeviceMessagingConfig } from '../../config/schema.js';
import type { PluginTuning } from '../plugin.interface.js';

type PluginConfigEntry = DeviceMessagingConfig['plugins'][number];

/** Partial override shape for `plugins[].tuning` (unknown keys rejected). */
const tuningOverrideSchema = z.object({
  nsInFlightTimeoutMs: z.number().int().positive().optional(),
  relayNodeInFlightTimeoutMs: z.number().int().positive().optional(),
  deviceInFlightTimeoutMs: z.number().int().positive().optional(),
  initialPollDelayMs: z.number().int().positive().optional(),
}).strict();

/**
 * Merge config tuning overrides onto plugin code defaults.
 *
 * @param defaults - Plugin-owned default {@link PluginTuning}
 * @param entry - Config `plugins[]` entry (`id` used in error text)
 * @returns Merged tuning (defaults when `entry.tuning` is absent)
 * @throws If `entry.tuning` has unknown keys or invalid values
 */
export function mergePluginTuning(
  defaults: PluginTuning,
  entry: PluginConfigEntry,
): PluginTuning {
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
