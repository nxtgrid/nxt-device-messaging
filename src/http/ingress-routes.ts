/**
 * @fileoverview Thin vendor ingress: `POST /ingress/:pluginId` (Unit 5.5).
 *
 * No Bearer API key (ADR-003 §5). Optional `plugin.incoming.verifySignature`.
 * HMAC/OpenAPI polish stays Phase 3.
 *
 * HTTP resolves the plugin once (enablement, PUSH support, signature), then
 * hands it to {@link Incoming.handle} — no second registry lookup in the engine.
 */

import type { FastifyPluginAsync } from 'fastify';

import type { Incoming } from '../engine/incoming.js';
import type { PluginId } from '../lib/device-message/types.js';
import type { PluginRegistry } from '../plugins/registry.js';
import { pluginIdParamsSchema } from './message-params.js';

export type IngressRoutesOpts = {
  readonly incoming: Incoming;
  readonly registry: PluginRegistry;
};

/**
 * Registers unauthenticated vendor webhook ingress.
 */
export const ingressRoutes: FastifyPluginAsync<IngressRoutesOpts> = async (app, opts) => {
  // Keep the raw buffer for optional signature checks; parse JSON in-handler.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.post('/ingress/:pluginId', async (request, reply) => {
    const parsedParams = pluginIdParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ error: 'Invalid pluginId' });
    }

    const pluginId = parsedParams.data.pluginId as PluginId;
    const plugin = opts.registry.get(pluginId);
    if (!plugin) {
      return reply.code(400).send({ error: `Unknown or disabled pluginId: ${ pluginId }` });
    }

    if (!plugin.incoming.handle) {
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

    await opts.incoming.handle(event, plugin);
    return reply.code(204).send();
  });
};
