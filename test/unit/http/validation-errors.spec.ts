import { describe, expect, it } from 'vitest';

import { buildApp } from '#src/app.js';
import { STUB_PUSH_ID } from '#src/plugins/stub/index.js';
import { createInMemoryOutgoingService } from '../../helpers/in-memory-outgoing.js';
import { noopMetrics } from '../../helpers/noop-metrics.js';

const enqueueBase = {
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

describe('HTTP validation error bodies', () => {
  it('includes dotted field paths and Zod messages for invalid bodies', async () => {
    const app = await buildApp({
      metrics: noopMetrics,
      outgoingService: createInMemoryOutgoingService({ knownPluginIds: [ STUB_PUSH_ID ] }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/message/enqueue',
      payload: {
        ...enqueueBase,
        device: { type: 'ELECTRICITY_METER' },
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as {
      error: string;
      issues: { path: string; message: string }[];
    };
    expect(body.error).toBe('Invalid request body');
    expect(body.issues).toEqual([
      expect.objectContaining({
        path: 'device.externalReference',
        message: expect.stringMatching(/\S/),
      }),
    ]);

    await app.close();
  });

  it('lists each missing required field', async () => {
    const app = await buildApp({
      metrics: noopMetrics,
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
    const paths = body.issues.map(issue => issue.path);
    expect(paths).toEqual(expect.arrayContaining([
      'commandType',
      'priority',
      'networkId',
      'device',
    ]));
    for (const issue of body.issues) {
      expect(issue.message).toMatch(/\S/);
    }

    await app.close();
  });
});
