/**
 * @fileoverview Env secrets for `calin-api-v2` (ADR-002 §2 / §6).
 *
 * Names follow the plugin id (`calin-api-v2` → `CALIN_API_V2_*`), not the legacy
 * `CALIN_V2_*` prefix from frozen tiamat. Reads `process.env` only — tests stub
 * via Vitest `vi.stubEnv`.
 */

import { requireEnvKeys } from '../../_shared/require-env-keys.js';

/** Required environment keys for this plugin. */
export const CALIN_API_V2_ENV_KEYS = [
  'CALIN_API_V2_URL',
  'CALIN_API_V2_COMPANY_NAME',
  'CALIN_API_V2_CUSTOMER_ID',
  'CALIN_API_V2_ADMIN_USERNAME',
  'CALIN_API_V2_ADMIN_PASSWORD',
  'CALIN_API_V2_POS_PASSWORD',
] as const;

/** Validated secrets for the CALIN API V2 plugin. */
export type CalinApiV2Secrets = {
  readonly apiBaseUrl: string;
  readonly companyName: string;
  readonly customerId: string;
  readonly adminUsername: string;
  readonly adminPassword: string;
  readonly posPassword: string;
};

/**
 * Read and validate {@link CALIN_API_V2_ENV_KEYS} from `process.env`.
 *
 * @returns Validated secrets
 * @throws If any required key is missing or blank (`MISSING …`)
 */
export function loadCalinApiV2Secrets(): CalinApiV2Secrets {
  const values = requireEnvKeys('calin-api-v2', CALIN_API_V2_ENV_KEYS);

  return {
    apiBaseUrl: values.CALIN_API_V2_URL,
    companyName: values.CALIN_API_V2_COMPANY_NAME,
    customerId: values.CALIN_API_V2_CUSTOMER_ID,
    adminUsername: values.CALIN_API_V2_ADMIN_USERNAME,
    adminPassword: values.CALIN_API_V2_ADMIN_PASSWORD,
    posPassword: values.CALIN_API_V2_POS_PASSWORD,
  };
}
