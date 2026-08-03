/**
 * @fileoverview Thin command route: `POST /token/generate` (Unit 5.6).
 *
 * Bearer when configured (ADR-003 §5). Lean Zod + map domain errors. HMAC/OpenAPI
 * polish stays Phase 3.
 */

import type { FastifyPluginAsync } from 'fastify';

import { TokenNotSupportedError, UnknownPluginError } from '../engine/errors.js';
import type { TokenService } from '../engine/token.js';
import { generateTokenBodySchema } from '../lib/device-message/schemas.js';
import { createApiKeyHook } from './auth.js';

export type TokenRoutesOpts = {
  readonly tokenService: TokenService;
  /** When set, command routes require Bearer auth. */
  readonly apiKey?: string;
};

/**
 * Registers the sync token-generate command route.
 */
export const tokenRoutes: FastifyPluginAsync<TokenRoutesOpts> = async (app, opts) => {
  app.addHook('onRequest', createApiKeyHook(opts.apiKey));

  app.post('/token/generate', async (request, reply) => {
    const parsed = generateTokenBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body' });
    }

    try {
      const token = await opts.tokenService.generate(parsed.data);
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
