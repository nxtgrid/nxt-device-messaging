/**
 * @fileoverview `calin-api-v2` provisioning facet.
 *
 * One operation: `sendRequest`. Metering owns the uninstall sequence; this
 * facet only posts allowlisted vendor paths through the existing client.
 */

import { z } from 'zod';

import { InvalidProvisioningError } from '../../engine/errors.js';
import type { PluginProvisioning } from '../plugin.interface.js';
import type { CalinApiV2Client } from './lib/repo.js';

const PLUGIN_ID = 'calin-api-v2';

/** Paths metering uses for CALIN V2 NS deregistration. */
export const CALIN_API_V2_PROVISIONING_PATHS = [
  '/api/concentrator/updateStatusFile',
  '/API/ConcentratorFile/Read',
  '/api/concentratorFile/delete',
  '/api/account/delete',
] as const;

const ALLOWED_PATHS = new Set<string>(CALIN_API_V2_PROVISIONING_PATHS);

const scalarSchema = z.union([ z.string(), z.number(), z.boolean() ]);

const sendRequestPayloadSchema = z.object({
  path: z.string().min(1),
  body: z.union([
    z.record(z.string(), scalarSchema),
    z.array(z.record(z.string(), scalarSchema)),
  ]),
}).strict();

/**
 * Build the CALIN API V2 provisioning facet.
 *
 * @param deps - Authenticated vendor HTTP client
 */
export function createCalinApiV2Provisioning(deps: {
  readonly client: CalinApiV2Client;
}): PluginProvisioning {
  const { client } = deps;

  return {
    async execute(input): Promise<unknown> {
      if (input.operation !== 'sendRequest') {
        throw new InvalidProvisioningError(
          PLUGIN_ID,
          `unsupported operation: ${ input.operation }`,
        );
      }

      const parsed = sendRequestPayloadSchema.safeParse(input.payload);
      if (!parsed.success) {
        throw new InvalidProvisioningError(
          PLUGIN_ID,
          parsed.error.issues[0]?.message ?? 'invalid sendRequest payload',
        );
      }

      const { path, body } = parsed.data;
      if (!ALLOWED_PATHS.has(path)) {
        throw new InvalidProvisioningError(
          PLUGIN_ID,
          `path is not allowlisted: ${ path }`,
        );
      }

      return client.sendRequest(path, body);
    },
  };
}
