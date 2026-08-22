/**
 * @fileoverview Thin command routes: enqueue, get-by-correlation, cancel.
 *
 * Lean HTTP: Zod route schemas + auth + map domain errors. Plugin enablement
 * lives in {@link OutgoingService}.
 */

import type { FastifyPluginAsyncZod } from '@fastify/type-provider-zod';

import {
  InvalidEnqueueError,
  UnknownPluginError,
  UnsupportedCommandTypeError,
} from '../engine/errors.js';
import type { OutgoingService } from '../engine/outgoing.js';
import { omitInternalFields } from '../lib/device-message/omit-internal-fields.js';
import {
  cancelManyBodySchema,
  cancelMessageResultSchema,
  cancelOneBodySchema,
  createDeviceMessageSchema,
  deviceMessageResponseSchema,
} from '../lib/device-message/schemas.js';
import { createApiKeyHook } from './auth.js';
import { correlationIdParamsSchema } from './message-params.js';
import { errorBodySchema } from './response-schemas.js';

export type MessageRoutesOpts = {
  readonly outgoingService: OutgoingService;
  /** When set, command routes require Bearer auth. */
  readonly apiKey?: string;
};

/**
 * Registers enqueue, get-by-correlation, and cancel command routes.
 */
export const messageRoutes: FastifyPluginAsyncZod<MessageRoutesOpts> = async (app, opts) => {
  app.addHook('onRequest', createApiKeyHook(opts.apiKey));

  app.post('/message/enqueue', {
    schema: {
      tags: [ 'command' ],
      body: createDeviceMessageSchema,
      response: {
        201: deviceMessageResponseSchema,
        400: errorBodySchema,
      },
    },
  }, async (request, reply) => {
    try {
      const message = await opts.outgoingService.enqueue(request.body);
      return reply.code(201).send(omitInternalFields(message));
    }
    catch (err) {
      if (
        err instanceof UnknownPluginError
        || err instanceof UnsupportedCommandTypeError
        || err instanceof InvalidEnqueueError
      ) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get('/message/:correlationId', {
    schema: {
      tags: [ 'command' ],
      params: correlationIdParamsSchema,
      response: {
        200: deviceMessageResponseSchema,
        400: errorBodySchema,
        404: errorBodySchema,
      },
    },
  }, async (request, reply) => {
    const message = await opts.outgoingService.getByCorrelationId(
      request.params.correlationId,
    );
    if (message === null) {
      return reply.code(404).send({ error: 'Not found' });
    }

    return omitInternalFields(message);
  });

  app.post('/message/cancel', {
    schema: {
      tags: [ 'command' ],
      body: cancelOneBodySchema,
      response: {
        200: cancelMessageResultSchema,
        400: errorBodySchema,
      },
    },
  }, async (request, reply) => {
    const result = await opts.outgoingService.cancelOne(request.body.correlationId);
    return reply.code(200).send(result);
  });

  app.post('/messages/cancel', {
    schema: {
      tags: [ 'command' ],
      body: cancelManyBodySchema,
      response: {
        200: cancelMessageResultSchema.array(),
        400: errorBodySchema,
      },
    },
  }, async (request, reply) => {
    const results = await opts.outgoingService.cancelMany(request.body.correlationIds);
    return reply.code(200).send(results);
  });
};
