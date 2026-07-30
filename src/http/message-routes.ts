/**
 * @fileoverview Thin command routes: enqueue + get-by-correlation (Intermezzo I3).
 *
 * Lean HTTP: Zod + auth + map domain errors. Plugin enablement lives in {@link Outgoing}.
 */

import type { FastifyPluginAsync } from 'fastify';

import { UnknownPluginError, type Outgoing } from '../engine/outgoing.js';
import { createDeviceMessageSchema } from '../lib/device-message/schemas.js';
import { createApiKeyHook } from './auth.js';
import { correlationIdParamsSchema } from './message-params.js';

export type MessageRoutesOpts = {
  readonly outgoing: Outgoing;
  /** When set, command routes require Bearer auth. */
  readonly apiKey?: string;
};

/**
 * Registers `POST /message/enqueue` and `GET /message/:correlationId`.
 */
export const messageRoutes: FastifyPluginAsync<MessageRoutesOpts> = async (app, opts) => {
  app.addHook('onRequest', createApiKeyHook(opts.apiKey));

  app.post('/message/enqueue', async (request, reply) => {
    const parsed = createDeviceMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body' });
    }

    try {
      const message = await opts.outgoing.enqueue(parsed.data);
      return reply.code(201).send(message);
    }
    catch (err) {
      if (err instanceof UnknownPluginError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get('/message/:correlationId', async (request, reply) => {
    const parsed = correlationIdParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid correlationId' });
    }

    const message = await opts.outgoing.getByCorrelationId(parsed.data.correlationId);
    if (message === null) {
      return reply.code(404).send({ error: 'Not found' });
    }

    return message;
  });
};
