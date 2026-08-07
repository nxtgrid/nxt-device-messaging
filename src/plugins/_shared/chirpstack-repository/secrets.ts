/**
 * @fileoverview Env secrets for the shared ChirpStack gRPC client (ADR-002 §2 / §6).
 *
 * Names stay vendor-scoped (`CHIRPSTACK_*`), not plugin-id-prefixed — this client
 * may serve more than one LoRaWAN brand plugin. Reads `process.env` only; tests
 * stub via Vitest `vi.stubEnv`.
 *
 * The gRPC client itself lands in Unit 10.2; this loader is shared from 10.1 so
 * `calin-chirpstack` can fail fast at construct when secrets are missing.
 */

import { requireEnvKeys } from '../require-env-keys.js';

/** Required environment keys for the ChirpStack repository. */
export const CHIRPSTACK_ENV_KEYS = [
  'CHIRPSTACK_API_URL',
  'CHIRPSTACK_API_TOKEN',
  'CHIRPSTACK_APPLICATION_ID',
  'CHIRPSTACK_PROFILE_ID',
  'CHIRPSTACK_APP_KEY',
] as const;

/** Validated secrets for the ChirpStack gRPC client. */
export type ChirpstackSecrets = {
  readonly apiUrl: string;
  readonly apiToken: string;
  readonly applicationId: string;
  readonly profileId: string;
  readonly appKey: string;
};

/**
 * Read and validate {@link CHIRPSTACK_ENV_KEYS} from `process.env`.
 *
 * @returns Validated secrets
 * @throws If any required key is missing or blank (`MISSING …`)
 */
export function loadChirpstackSecrets(): ChirpstackSecrets {
  const values = requireEnvKeys('chirpstack', CHIRPSTACK_ENV_KEYS);

  return {
    apiUrl: values.CHIRPSTACK_API_URL,
    apiToken: values.CHIRPSTACK_API_TOKEN,
    applicationId: values.CHIRPSTACK_APPLICATION_ID,
    profileId: values.CHIRPSTACK_PROFILE_ID,
    appKey: values.CHIRPSTACK_APP_KEY,
  };
}
