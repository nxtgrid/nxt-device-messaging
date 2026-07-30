import { describe, expect, it } from 'vitest';

import type { BottleneckKeyInput } from '../../../src/plugins/plugin.interface.js';
import type { DeviceMessage } from '../../../src/lib/device-message/types.js';
import {
  createStubPlugin,
  createStubPullPlugin,
  createStubPushPlugin,
  STUB_PULL_ID,
  STUB_PUSH_ID,
} from '../../../src/plugins/stub/index.js';

const deviceOnly: BottleneckKeyInput = {
  networkId: 42,
  device: {
    type: 'ELECTRICITY_METER',
    externalReference: 'm-1',
  },
};

const sampleMessage = {
  id: 'msg-1',
  commandType: 'READ',
  pluginId: STUB_PUSH_ID,
  networkId: 42,
  device: deviceOnly.device,
  deliveryQueueId: '',
  deliveryStatus: 'QUEUED',
} as DeviceMessage;

describe('stub plugins', () => {
  it('createStubPushPlugin uses PUSH + spacing and stub_network bottleneck', () => {
    const plugin = createStubPushPlugin({ id: STUB_PUSH_ID });
    expect(plugin.id).toBe(STUB_PUSH_ID);
    expect(plugin.deliveryPattern).toBe('PUSH');
    expect(plugin.admission).toEqual({ strategy: 'spacing', minIntervalMs: 2000 });
    expect(plugin.bottleneckKey(deviceOnly)).toBe('queue:stub_network:42');
    expect(plugin.bottleneckKey({ ...deviceOnly, networkId: null })).toBe(
      'queue:stub_network:unassigned',
    );
    expect(plugin.incoming.handle).toBeTypeOf('function');
    expect(plugin.incoming.fetchStatus).toBeUndefined();
    expect(plugin.incoming.handle?.({})).toBeNull();
  });

  it('createStubPullPlugin uses PULL + concurrency and stub_gateway bottleneck', async () => {
    const plugin = createStubPullPlugin({ id: STUB_PULL_ID });
    expect(plugin.id).toBe(STUB_PULL_ID);
    expect(plugin.deliveryPattern).toBe('PULL');
    expect(plugin.admission).toEqual({ strategy: 'concurrency', maxInFlight: 5 });
    expect(
      plugin.bottleneckKey({
        networkId: null,
        device: { ...deviceOnly.device, gateway: { id: 7 } },
      }),
    ).toBe('queue:stub_gateway:7');
    expect(plugin.bottleneckKey(deviceOnly)).toBe('queue:stub_gateway:unassigned');
    expect(plugin.incoming.fetchStatus).toBeTypeOf('function');
    expect(plugin.incoming.handle).toBeUndefined();
    await expect(plugin.incoming.fetchStatus?.(sampleMessage)).resolves.toBeNull();
  });

  it('outgoing sendOne is a no-op that returns a stub external id', async () => {
    const plugin = createStubPlugin({
      id: 'custom-stub',
      deliveryPattern: 'PUSH',
      admission: { strategy: 'spacing', minIntervalMs: 1 },
    });
    await expect(plugin.outgoing.sendOne(sampleMessage)).resolves.toBe('stub-ext-id');
    expect(plugin.outgoing.getRemoteStatus(sampleMessage)).toEqual({
      deliveryStatus: 'QUEUED',
    });
    expect(plugin.outgoing.parseError(new Error('boom'))).toEqual({ reason: 'boom' });
  });
});
