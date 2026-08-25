/**
 * @fileoverview `calin-chirpstack` provisioning facet.
 *
 * Operations: `registerDevice`, `setApplicationKey`. Metering owns install
 * sequencing (register, then keys when `isNewRegistration`).
 */

import { z } from 'zod';

import { InvalidProvisioningError } from '../../engine/errors.js';
import type { ChirpstackClient } from '../_shared/chirpstack-repository/index.js';
import type { PluginProvisioning } from '../plugin.interface.js';

const PLUGIN_ID = 'calin-chirpstack';

const registerDevicePayloadSchema = z.object({
  devEui: z.string().min(1),
  deviceName: z.string().min(1),
}).strict();

const setApplicationKeyPayloadSchema = z.object({
  devEui: z.string().min(1),
}).strict();

function parsePayload<T>(schema: z.ZodType<T>, payload: unknown, detail: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new InvalidProvisioningError(
      PLUGIN_ID,
      parsed.error.issues[0]?.message ?? detail,
    );
  }
  return parsed.data;
}

/**
 * Build the ChirpStack provisioning facet.
 *
 * @param deps - Shared gRPC device client
 */
export function createCalinChirpstackProvisioning(deps: {
  readonly client: ChirpstackClient;
}): PluginProvisioning {
  const { client } = deps;

  return {
    async execute(input): Promise<unknown> {
      if (input.operation === 'registerDevice') {
        const payload = parsePayload(
          registerDevicePayloadSchema,
          input.payload,
          'invalid registerDevice payload',
        );
        return client.registerDevice(payload.devEui, payload.deviceName);
      }

      if (input.operation === 'setApplicationKey') {
        const payload = parsePayload(
          setApplicationKeyPayloadSchema,
          input.payload,
          'invalid setApplicationKey payload',
        );
        return client.setApplicationKeyForDevice(payload.devEui);
      }

      throw new InvalidProvisioningError(
        PLUGIN_ID,
        `unsupported operation: ${ input.operation }`,
      );
    },
  };
}
