/**
 * @fileoverview Thin command route: `POST /plugin/provisioning`.
 *
 * Bearer when configured (ADR-003 §5). Zod route schemas + map domain errors.
 */

import type { FastifyPluginAsyncZod } from '@fastify/type-provider-zod';

import {
  InvalidProvisioningError,
  ProvisioningNotSupportedError,
  UnknownPluginError,
} from '../engine/errors.js';
import type { ProvisioningService } from '../engine/provisioning.js';
import { pluginProvisioningRequestSchema } from '../lib/device-message/schemas.js';
import { createApiKeyHook } from './auth.js';
import { errorBodySchema, pluginProvisioningResponseSchema } from './response-schemas.js';

export type ProvisioningRoutesOpts = {
  readonly provisioningService: ProvisioningService;
  /** When set, command routes require Bearer auth. */
  readonly apiKey?: string;
};

/**
 * Registers the sync plugin-provisioning command route.
 */
export const provisioningRoutes: FastifyPluginAsyncZod<ProvisioningRoutesOpts> = async (
  app,
  opts,
) => {
  app.addHook('onRequest', createApiKeyHook(opts.apiKey));

  app.post('/plugin/provisioning', {
    schema: {
      tags: [ 'command' ],
      body: pluginProvisioningRequestSchema,
      response: {
        200: pluginProvisioningResponseSchema,
        400: errorBodySchema,
      },
    },
  }, async (request, reply) => {
    try {
      const result = await opts.provisioningService.execute(request.body);
      return reply.code(200).send({ result });
    }
    catch (err) {
      if (
        err instanceof UnknownPluginError
        || err instanceof ProvisioningNotSupportedError
        || err instanceof InvalidProvisioningError
      ) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });
};
