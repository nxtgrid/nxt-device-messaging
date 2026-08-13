import { describe, expect, it } from 'vitest';

import { buildApp } from '#src/app.js';
import { InvalidEnqueueError } from '#src/engine/errors.js';
import { STUB_PUSH_ID } from '#src/plugins/stub/index.js';
import { createInMemoryOutgoingService } from '../../helpers/in-memory-outgoing.js';

const enqueueBody = {
  commandType: 'READ_CREDIT',
  priority: 1,
  pluginId: STUB_PUSH_ID,
  networkId: 42,
  correlationId: 'corr-1',
  device: {
    type: 'ELECTRICITY_METER' as const,
    externalReference: 'm-1',
  },
};

describe('message command routes (enqueue / get / cancel)', () => {
  it('enqueues via outgoing and returns via get (camelCase)', async () => {
    const outgoingService = createInMemoryOutgoingService({ knownPluginIds: [ STUB_PUSH_ID ] });
    const app = await buildApp({ outgoingService });

    const enqueue = await app.inject({
      method: 'POST',
      url: '/message/enqueue',
      payload: enqueueBody,
    });
    expect(enqueue.statusCode).toBe(201);
    const created = enqueue.json();
    expect(created.correlationId).toBe('corr-1');
    expect(created.commandType).toBe('READ_CREDIT');
    expect(created.networkId).toBe(42);
    expect(created.device.externalReference).toBe('m-1');
    expect(created.deliveryStatus).toBe('QUEUED');
    expect(created.id).toEqual(expect.any(String));

    const get = await app.inject({
      method: 'GET',
      url: '/message/corr-1',
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual(created);

    await app.close();
  });

  it('maps UnknownPluginError from outgoing to 400', async () => {
    const app = await buildApp({
      outgoingService: createInMemoryOutgoingService({ knownPluginIds: [ STUB_PUSH_ID ] }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/message/enqueue',
      payload: { ...enqueueBody, pluginId: 'calin-chirpstack' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Unknown or disabled pluginId: calin-chirpstack',
    });

    await app.close();
  });

  it('maps UnsupportedCommandTypeError from outgoing to 400', async () => {
    const app = await buildApp({
      outgoingService: createInMemoryOutgoingService({
        knownPluginIds: [ STUB_PUSH_ID ],
        supportedCommandTypes: [ 'TURN_ON' ],
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/message/enqueue',
      payload: enqueueBody,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: `Plugin ${ STUB_PUSH_ID } does not support commandType: READ_CREDIT`,
    });

    await app.close();
  });

  it('maps InvalidEnqueueError from outgoing to 400', async () => {
    const outgoingService = createInMemoryOutgoingService({
      knownPluginIds: [ STUB_PUSH_ID ],
    });
    outgoingService.enqueue = async () => {
      throw new InvalidEnqueueError(STUB_PUSH_ID, 'device.relayNode.id is required');
    };

    const app = await buildApp({ outgoingService });
    const response = await app.inject({
      method: 'POST',
      url: '/message/enqueue',
      payload: enqueueBody,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: `Plugin ${ STUB_PUSH_ID }: device.relayNode.id is required`,
    });

    await app.close();
  });

  it('returns 404 when correlation id is missing', async () => {
    const app = await buildApp({
      outgoingService: createInMemoryOutgoingService(),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/message/missing',
    });
    expect(response.statusCode).toBe(404);

    await app.close();
  });

  it('requires Bearer when apiKey is configured', async () => {
    const app = await buildApp({
      outgoingService: createInMemoryOutgoingService({ knownPluginIds: [ STUB_PUSH_ID ] }),
      apiKey: 'secret',
    });

    const unauthorized = await app.inject({
      method: 'POST',
      url: '/message/enqueue',
      payload: enqueueBody,
    });
    expect(unauthorized.statusCode).toBe(401);

    const authorized = await app.inject({
      method: 'POST',
      url: '/message/enqueue',
      headers: { authorization: 'Bearer secret' },
      payload: enqueueBody,
    });
    expect(authorized.statusCode).toBe(201);

    const healthz = await app.inject({ method: 'GET', url: '/healthz' });
    expect(healthz.statusCode).toBe(200);

    await app.close();
  });

  it('rejects invalid bodies', async () => {
    const app = await buildApp({
      outgoingService: createInMemoryOutgoingService({ knownPluginIds: [ STUB_PUSH_ID ] }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/message/enqueue',
      payload: { pluginId: STUB_PUSH_ID },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as {
      error: string;
      issues: { path: string; message: string }[];
    };
    expect(body.error).toBe('Invalid request body');
    expect(body.issues.length).toBeGreaterThan(0);
    expect(body.issues.every(issue => issue.message.length > 0)).toBe(true);

    await app.close();
  });

  it('cancels one via POST /message/cancel', async () => {
    const outgoingService = createInMemoryOutgoingService({ knownPluginIds: [ STUB_PUSH_ID ] });
    const app = await buildApp({ outgoingService });

    await app.inject({
      method: 'POST',
      url: '/message/enqueue',
      payload: enqueueBody,
    });

    const cancelled = await app.inject({
      method: 'POST',
      url: '/message/cancel',
      payload: { correlationId: 'corr-1' },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toEqual({ correlationId: 'corr-1', result: 'CANCELLED' });

    const missing = await app.inject({
      method: 'GET',
      url: '/message/corr-1',
    });
    expect(missing.statusCode).toBe(404);

    const notFound = await app.inject({
      method: 'POST',
      url: '/message/cancel',
      payload: { correlationId: 'never-enqueued' },
    });
    expect(notFound.statusCode).toBe(200);
    expect(notFound.json()).toEqual({
      correlationId: 'never-enqueued',
      result: 'NOT_FOUND',
    });

    await app.close();
  });

  it('cancels many via POST /messages/cancel', async () => {
    const outgoingService = createInMemoryOutgoingService({ knownPluginIds: [ STUB_PUSH_ID ] });
    const app = await buildApp({ outgoingService });

    await app.inject({
      method: 'POST',
      url: '/message/enqueue',
      payload: { ...enqueueBody, correlationId: 'corr-a' },
    });
    await app.inject({
      method: 'POST',
      url: '/message/enqueue',
      payload: { ...enqueueBody, correlationId: 'corr-b' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/messages/cancel',
      payload: { correlationIds: [ 'corr-a', 'corr-b', 'corr-missing' ] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { correlationId: 'corr-a', result: 'CANCELLED' },
      { correlationId: 'corr-b', result: 'CANCELLED' },
      { correlationId: 'corr-missing', result: 'NOT_FOUND' },
    ]);

    await app.close();
  });
});
