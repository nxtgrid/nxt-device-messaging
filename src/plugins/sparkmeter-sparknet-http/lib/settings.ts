/**
 * @fileoverview `sparkmeter-sparknet-http` settings (ADR-002 §1).
 *
 * Non-secret topology and fleet configure constants. Parsed at construct;
 * a missing required field fails boot.
 */

import { z } from 'zod';

import type { DeviceMessagingConfig } from '../../../config/schema.js';

type PluginConfigEntry = DeviceMessagingConfig['plugins'][number];

/**
 * Amps posted when `meterConfiguration.currentLimit` is omitted.
 * A present zero is kept. 200 A is the largest inrush ThunderCloud seeds.
 */
const DEFAULT_CURRENT_LIMIT_AMPS = 200;

const basestationSchema = z.object({
  id: z.uint32(),
  baseUrl: z.url({ protocol: /^https?$/ }),
}).strict();

const meterConfigurationSchema = z.object({
  currentLimit: z.number().nonnegative().optional(),
  startupDelay: z.uint32(),
  throttleOnTime: z.uint32(),
  throttleOffTime: z.uint32(),
  throttleCountLimit: z.uint32(),
}).strict();

const settingsSchema = z.object({
  basestations: z.array(basestationSchema).min(1),
  meterConfiguration: meterConfigurationSchema,
}).strict();

/** One sparknet-http process this plugin can post to. */
type SparkmeterBasestation = {
  readonly id: number;
  readonly baseUrl: string;
};

/**
 * Fleet configure constants. `sendOne` reads these when it posts configure.
 * `currentLimit` is always set after load: omitted in JSON becomes 200 amps,
 * and a present zero stays zero.
 */
export type SparkmeterMeterConfiguration = {
  readonly currentLimit: number;
  readonly startupDelay: number;
  readonly throttleOnTime: number;
  readonly throttleOffTime: number;
  readonly throttleCountLimit: number;
};

/** Parsed `plugins[].settings` for this plugin. */
export type SparkmeterSparknetHttpSettings = {
  readonly basestations: readonly SparkmeterBasestation[];
  readonly meterConfiguration: SparkmeterMeterConfiguration;
};

/**
 * Parse and normalize this plugin's config settings.
 *
 * @param entry - Config `plugins[]` entry for this id
 * @returns Basestations and meter configuration, with `currentLimit` filled in
 * @throws If settings are missing, invalid, or list the same basestation id twice
 */
export function loadSparkmeterSparknetHttpSettings(
  entry: PluginConfigEntry,
): SparkmeterSparknetHttpSettings {
  if (entry.settings === undefined) {
    throw new Error(`Invalid settings for plugin "${ entry.id }": settings are required`);
  }

  const parsed = settingsSchema.safeParse(entry.settings);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map(issue => {
        const path = issue.path.join('.');
        return path === '' ? issue.message : `${ path }: ${ issue.message }`;
      })
      .join('; ');
    throw new Error(`Invalid settings for plugin "${ entry.id }": ${ detail }`);
  }

  const seenIds = new Set<number>();
  for (const basestation of parsed.data.basestations) {
    if (seenIds.has(basestation.id)) {
      throw new Error(
        `Invalid settings for plugin "${ entry.id }": duplicate basestation id ${ basestation.id }`,
      );
    }
    seenIds.add(basestation.id);
  }

  const meterConfiguration = parsed.data.meterConfiguration;
  return {
    basestations: parsed.data.basestations,
    meterConfiguration: {
      currentLimit: meterConfiguration.currentLimit ?? DEFAULT_CURRENT_LIMIT_AMPS,
      startupDelay: meterConfiguration.startupDelay,
      throttleOnTime: meterConfiguration.throttleOnTime,
      throttleOffTime: meterConfiguration.throttleOffTime,
      throttleCountLimit: meterConfiguration.throttleCountLimit,
    },
  };
}
