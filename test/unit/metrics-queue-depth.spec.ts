import { describe, expect, it } from 'vitest';

import { collectQueueDepths } from '#src/metrics/queue-depth.js';
import { createFakeQueueDepthRedis } from '../helpers/fake-queue-depth-redis.js';

describe('collectQueueDepths', () => {
  it('ZCARDs every stage queue, the webhook set, and distributor members', async () => {
    const redis = createFakeQueueDepthRedis({
      members: [ 'queue:stub-push:network:42' ],
      cards: {
        queue_in_flight_to_ns: 3,
        queue_in_flight_to_relay_node: 0,
        queue_in_flight_to_device: 1,
        queue_awaiting_retry: 4,
        'webhook:pending': 2,
        'queue_awaiting_task:calin-api-v1': 5,
        'queue:stub-push:network:42': 7,
      },
    });

    const depths = await collectQueueDepths({
      redis,
      pullPluginIds: [ 'calin-api-v1' ],
    });

    // Stage rows come first, in stage-table order, because they are derived from it.
    expect(depths).toEqual([
      { queue: 'queue_in_flight_to_ns', depth: 3 },
      { queue: 'queue_in_flight_to_relay_node', depth: 0 },
      { queue: 'queue_in_flight_to_device', depth: 1 },
      { queue: 'queue_awaiting_task:calin-api-v1', depth: 5 },
      { queue: 'queue_awaiting_retry', depth: 4 },
      { queue: 'webhook:pending', depth: 2 },
      { queue: 'queue:stub-push:network:42', depth: 7 },
    ]);
  });

  it('dedupes a distributor member that matches a known stage key', async () => {
    const redis = createFakeQueueDepthRedis({
      members: [ 'queue_awaiting_retry' ],
      cards: { queue_awaiting_retry: 9 },
    });

    const depths = await collectQueueDepths({ redis, pullPluginIds: [] });
    const retry = depths.filter(row => row.queue === 'queue_awaiting_retry');
    expect(retry).toEqual([ { queue: 'queue_awaiting_retry', depth: 9 } ]);
  });
});
