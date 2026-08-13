/**
 * @fileoverview Thin command route: `POST /token/generate` (Unit 5.6).
 *
 * Bearer when configured (ADR-003 §5). Zod route schemas + map domain errors.
 */

import type { FastifyPluginAsyncZod } from '@fastify/type-provider-zod';

import { TokenNotSupportedError, UnknownPluginError } from '../engine/errors.js';
import type { TokenService } from '../engine/token.js';
import { generateTokenSchema } from '../lib/device-message/schemas.js';
import { createApiKeyHook } from './auth.js';
import { errorBodySchema, generateTokenResponseSchema } from './response-schemas.js';

export type TokenRoutesOpts = {
  readonly tokenService: TokenService;
  /** When set, command routes require Bearer auth. */
  readonly apiKey?: string;
};

/**
 * Registers the sync token-generate command route.
 */
export const tokenRoutes: FastifyPluginAsyncZod<TokenRoutesOpts> = async (app, opts) => {
  app.addHook('onRequest', createApiKeyHook(opts.apiKey));

  app.post('/token/generate', {
    schema: {
      tags: [ 'command' ],
      body: generateTokenSchema,
      response: {
        200: generateTokenResponseSchema,
        400: errorBodySchema,
      },
    },
  }, async (request, reply) => {
    try {
      const token = await opts.tokenService.generate(request.body);
      return reply.code(200).send({ token });
    }
    catch (err) {
      if (err instanceof UnknownPluginError || err instanceof TokenNotSupportedError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });
};
