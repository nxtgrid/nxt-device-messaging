/**
 * @fileoverview Thin command routes: enqueue, get-by-correlation, cancel (Unit 5.2).
 *
 * Lean HTTP: Zod + auth + map domain errors. Plugin enablement lives in {@link Outgoing}.
 */

import type { FastifyPluginAsync } from 'fastify';

import { UnknownPluginError, type Outgoing } from '../engine/outgoing.js';
import {
  cancelManyBodySchema,
  cancelOneBodySchema,
  createDeviceMessageSchema,
} from '../lib/device-message/schemas.js';
import { createApiKeyHook } from './auth.js';
import { correlationIdParamsSchema } from './message-params.js';

export type MessageRoutesOpts = {
  readonly outgoing: Outgoing;
  /** When set, command routes require Bearer auth. */
  readonly apiKey?: string;
};

/**
 * Registers enqueue, get-by-correlation, and cancel command routes.
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

  app.post('/message/cancel', async (request, reply) => {
    const parsed = cancelOneBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body' });
    }

    const result = await opts.outgoing.cancelOne(parsed.data.correlationId);
    return reply.code(200).send(result);
  });

  app.post('/messages/cancel', async (request, reply) => {
    const parsed = cancelManyBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body' });
    }

    const results = await opts.outgoing.cancelMany(parsed.data.correlationIds);
    return reply.code(200).send(results);
  });
};
