/**
 * @fileoverview Thin vendor ingress: `POST /ingress/:pluginId` (Unit 5.5).
 *
 * No Bearer API key (ADR-003 §5). Optional `plugin.incoming.verifySignature`.
 * Body is vendor-opaque: raw buffer kept for signatures; JSON parsed in-handler.
 *
 * HTTP resolves the plugin once (enablement, PUSH support, signature), then
 * hands it to {@link IncomingService.handle} — no second registry lookup in the
 * engine. Command routes leave enablement to their services; ingress is the
 * exception because signature verification needs the plugin before `handle`.
 */

import type { FastifyPluginAsyncZod } from '@fastify/type-provider-zod';
import { z } from 'zod';

import type { IncomingService } from '../engine/incoming.js';
import type { PluginId } from '../lib/device-message/types.js';
import type { PluginRegistry } from '../plugins/registry.js';
import { pluginIdParamsSchema } from './message-params.js';
import { errorBodySchema } from './response-schemas.js';

export type IngressRoutesOpts = {
  readonly incomingService: IncomingService;
  readonly registry: PluginRegistry;
};

/**
 * Vendor JSON is opaque to core (plugin parses). `z.unknown()` accepts the raw
 * Buffer from the content-type parser so signature verification still sees bytes.
 * OpenAPI would otherwise treat untyped `unknown` as a string (Swagger UI default);
 * `type: object` is documentation-only metadata.
 */
const ingressBodySchema = z.unknown().meta({
  type: 'object',
  additionalProperties: true,
  description:
    'Vendor-specific JSON (opaque to the service). The raw body is retained for optional signature checks; the enabled plugin parses the shape.',
  examples: [ { event: 'up', deviceInfo: { devEui: '0102030405060708' } } ],
});

/**
 * Registers unauthenticated vendor webhook ingress.
 */
export const ingressRoutes: FastifyPluginAsyncZod<IngressRoutesOpts> = async (app, opts) => {
  // Keep the raw buffer for optional signature checks; parse JSON in-handler.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.post('/ingress/:pluginId', {
    schema: {
      tags: [ 'ingress' ],
      params: pluginIdParamsSchema,
      body: ingressBodySchema,
      response: {
        204: z.null(),
        400: errorBodySchema,
        401: errorBodySchema,
      },
    },
  }, async (request, reply) => {
    const pluginId = request.params.pluginId as PluginId;
    const plugin = opts.registry.get(pluginId);
    if (!plugin) {
      return reply.code(400).send({ error: `Unknown or disabled pluginId: ${ pluginId }` });
    }

    if (plugin.deliveryPattern !== 'PUSH') {
      return reply.code(400).send({ error: `Plugin does not support PUSH ingress: ${ pluginId }` });
    }

    const rawBody = Buffer.isBuffer(request.body)
      ? request.body
      : Buffer.from('');

    if (plugin.incoming.verifySignature) {
      const headers: Record<string, string> = {};
      for (const [ key, value ] of Object.entries(request.headers)) {
        if (typeof value === 'string') {
          headers[key] = value;
        }
        else if (Array.isArray(value) && typeof value[0] === 'string') {
          headers[key] = value[0];
        }
      }

      const ok = await plugin.incoming.verifySignature(rawBody, headers);
      if (!ok) {
        return reply.code(401).send({ error: 'Invalid signature' });
      }
    }

    let event: unknown = null;
    if (rawBody.length > 0) {
      try {
        event = JSON.parse(rawBody.toString('utf8'));
      }
      catch {
        return reply.code(400).send({ error: 'Invalid JSON body' });
      }
    }

    await opts.incomingService.handle(event, plugin, {
      query: flattenQuery(request.query),
    });
    return reply.code(204).send(null);
  });
};

/** Flatten Fastify query values to a string map (first value wins for arrays). */
function flattenQuery(query: unknown): Record<string, string> {
  if (!query || typeof query !== 'object') return {};

  const out: Record<string, string> = {};
  for (const [ key, value ] of Object.entries(query as Record<string, unknown>)) {
    if (typeof value === 'string') {
      out[key] = value;
    }
    else if (Array.isArray(value) && typeof value[0] === 'string') {
      out[key] = value[0];
    }
  }
  return out;
}
