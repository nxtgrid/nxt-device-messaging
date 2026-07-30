/**
 * @fileoverview Thin command routes: enqueue + get-by-correlation (Intermezzo I2).
 *
 * No Redis yet (I3). Plugin enablement checked once via {@link PluginRegistry.get}.
 * Wire JSON is camelCase; domain stays snake_case until the Redis rename pass.
 */

import type { FastifyPluginAsync } from 'fastify';
import { ulid } from 'ulid';

import type { DeviceMessage } from '../lib/types.js';
import type { PluginRegistry } from '../plugins/registry.js';
import { createApiKeyHook } from './auth.js';
import type { MessageStore } from './message-store.js';
import { correlationIdParamsSchema, enqueueBodySchema } from './schemas.js';
import { deviceMessageToWire, enqueueBodyToDomain } from './wire.js';

export type MessageRoutesOpts = {
  readonly pluginRegistry: PluginRegistry;
  readonly messageStore: MessageStore;
  /** When set, command routes require Bearer auth. */
  readonly apiKey?: string;
};

/**
 * Registers `POST /message/enqueue` and `GET /message/:correlationId`.
 */
export const messageRoutes: FastifyPluginAsync<MessageRoutesOpts> = async (app, opts) => {
  app.addHook('onRequest', createApiKeyHook(opts.apiKey));

  app.post('/message/enqueue', async (request, reply) => {
    const parsed = enqueueBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body' });
    }

    const body = parsed.data;
    // @TOCHECK :: Do we need to do this every time? Does this cause lag?
    //             We should prevent doing double checking.
    if (opts.pluginRegistry.get(body.pluginId) === undefined) {
      return reply.code(400).send({
        error: `Unknown or disabled pluginId: ${ body.pluginId }`,
      });
    }

    const correlationId = body.correlationId ?? ulid();
    const created = enqueueBodyToDomain(body, correlationId);
    const message: DeviceMessage = {
      ...created,
      id: ulid(),
      delivery_queue_id: '',
      delivery_status: 'QUEUED',
    };

    opts.messageStore.set(correlationId, message);
    return reply.code(201).send(deviceMessageToWire(message));
  });

  app.get('/message/:correlationId', async (request, reply) => {
    const parsed = correlationIdParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid correlationId' });
    }

    const message = opts.messageStore.get(parsed.data.correlationId);
    if (message === undefined) {
      return reply.code(404).send({ error: 'Not found' });
    }

    return deviceMessageToWire(message);
  });
};
