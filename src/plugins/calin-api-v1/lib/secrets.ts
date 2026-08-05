/**
 * @fileoverview Env secrets for `calin-api-v1` (ADR-002 §2 / §6).
 *
 * Names follow the plugin id (`calin-api-v1` → `CALIN_API_V1_*`), not the legacy
 * `CALIN_V1_*` prefix from frozen tiamat. Reads `process.env` only — tests stub
 * via Vitest `vi.stubEnv`.
 */

/** Required environment keys for this plugin. */
export const CALIN_API_V1_ENV_KEYS = [
  'CALIN_API_V1_URL',
  'CALIN_API_V1_COMPANY_NAME',
  'CALIN_API_V1_ADMIN_USERNAME',
  'CALIN_API_V1_ADMIN_PASSWORD',
  'CALIN_API_V1_POS_USERNAME',
  'CALIN_API_V1_POS_PASSWORD',
  'CALIN_API_V1_MAINTENANCE_USERNAME',
  'CALIN_API_V1_MAINTENANCE_PASSWORD',
] as const;

type CalinApiV1EnvKey = (typeof CALIN_API_V1_ENV_KEYS)[number];

/** Validated secrets for the CALIN API V1 plugin. */
export type CalinApiV1Secrets = {
  readonly apiBaseUrl: string;
  readonly companyName: string;
  readonly adminUsername: string;
  readonly adminPassword: string;
  readonly posUsername: string;
  readonly posPassword: string;
  readonly maintenanceUsername: string;
  readonly maintenancePassword: string;
};

/**
 * Read and validate {@link CALIN_API_V1_ENV_KEYS} from `process.env`.
 *
 * @returns Validated secrets
 * Values are trimmed. Blank / whitespace-only counts as missing.
 *
 * @throws If any required key is missing or blank (`MISSING …`)
 */
export function loadCalinApiV1Secrets(): CalinApiV1Secrets {
  const values = {} as Record<CalinApiV1EnvKey, string>;
  const missing: CalinApiV1EnvKey[] = [];

  for (const key of CALIN_API_V1_ENV_KEYS) {
    const value = process.env[key];
    const trimmed = value?.trim();
    if (trimmed === undefined || trimmed === '') {
      missing.push(key);
    }
    else {
      values[key] = trimmed;
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `MISSING env for plugin "calin-api-v1": ${ missing.join(', ') }`,
    );
  }

  return {
    apiBaseUrl: values.CALIN_API_V1_URL,
    companyName: values.CALIN_API_V1_COMPANY_NAME,
    adminUsername: values.CALIN_API_V1_ADMIN_USERNAME,
    adminPassword: values.CALIN_API_V1_ADMIN_PASSWORD,
    posUsername: values.CALIN_API_V1_POS_USERNAME,
    posPassword: values.CALIN_API_V1_POS_PASSWORD,
    maintenanceUsername: values.CALIN_API_V1_MAINTENANCE_USERNAME,
    maintenancePassword: values.CALIN_API_V1_MAINTENANCE_PASSWORD,
  };
}
