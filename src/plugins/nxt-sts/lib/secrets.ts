/**
 * @fileoverview Env secrets for `nxt-sts` (ADR-002 §2 / §6).
 *
 * Names follow the plugin id (`nxt-sts` → `NXT_STS_*`).
 * Reads `process.env` only — tests stub via Vitest `vi.stubEnv`.
 */

import { requireEnvKeys } from '../../_shared/require-env-keys.js';

/** Required environment keys for this plugin. */
export const NXT_STS_ENV_KEYS = [
  'NXT_STS_URL',
] as const;

/** Validated secrets for the nxt-sts plugin. */
export type NxtStsSecrets = {
  readonly apiBaseUrl: string;
};

/**
 * Read and validate {@link NXT_STS_ENV_KEYS} from `process.env`.
 *
 * @returns Validated secrets
 * @throws If any required key is missing or blank (`MISSING …`)
 */
export function loadNxtStsSecrets(): NxtStsSecrets {
  const values = requireEnvKeys('nxt-sts', NXT_STS_ENV_KEYS);

  return {
    apiBaseUrl: values.NXT_STS_URL,
  };
}
