import { describe, expect, it } from 'vitest';

import type { InitialQueueKeyInput } from '../../../src/plugins/plugin.interface.js';
import { ENQUEUEABLE_COMMAND_TYPES } from '../../../src/lib/device-message/command-types.js';
import type { DeviceMessage } from '../../../src/lib/device-message/types.js';
import {
  createStubPlugin,
  createStubPullPlugin,
  createStubPushPlugin,
  STUB_PULL_ID,
  STUB_PUSH_ID,
} from '../../../src/plugins/stub/index.js';

const deviceOnly: InitialQueueKeyInput = {
  networkId: 42,
  device: {
    type: 'ELECTRICITY_METER',
    externalReference: 'm-1',
  },
};

const sampleMessage = {
  id: 'msg-1',
  commandType: 'READ_CREDIT',
  pluginId: STUB_PUSH_ID,
  networkId: 42,
  device: deviceOnly.device,
  deliveryQueueId: '',
  deliveryStatus: 'QUEUED',
} as DeviceMessage;

describe('stub plugins', () => {
  it('createStubPushPlugin uses PUSH + spacing and queue:stub-push:network:…', () => {
    const plugin = createStubPushPlugin({ id: STUB_PUSH_ID });
    expect(plugin.id).toBe(STUB_PUSH_ID);
    expect(plugin.deliveryPattern).toBe('PUSH');
    expect(plugin.supportedCommandTypes).toEqual(ENQUEUEABLE_COMMAND_TYPES);
    expect(plugin.admission).toEqual({ strategy: 'spacing', minIntervalMs: 2000 });
    expect(plugin.initialQueueKey(deviceOnly)).toBe('queue:stub-push:network:42');
    expect(plugin.initialQueueKey({ ...deviceOnly, networkId: null })).toBe(
      'queue:stub-push:network:unassigned',
    );
    expect(plugin.incoming.handle).toBeTypeOf('function');
    expect(plugin.incoming.fetchStatus).toBeUndefined();
    expect(plugin.incoming.handle?.({})).toBeNull();
    expect(plugin.incoming.handle?.({
      deliveryStatus: 'DELIVERY_SUCCESSFUL',
      device: deviceOnly.device,
      deliveryQueueId: 'stub-ext-id',
    })).toEqual({
      deliveryStatus: 'DELIVERY_SUCCESSFUL',
      device: deviceOnly.device,
      deliveryQueueId: 'stub-ext-id',
    });
  });

  it('createStubPullPlugin uses PULL + concurrency and queue:stub-pull:gateway:…', async () => {
    const plugin = createStubPullPlugin({ id: STUB_PULL_ID });
    expect(plugin.id).toBe(STUB_PULL_ID);
    expect(plugin.deliveryPattern).toBe('PULL');
    expect(plugin.admission).toEqual({ strategy: 'concurrency', maxInFlight: 5 });
    expect(
      plugin.initialQueueKey({
        networkId: null,
        device: { ...deviceOnly.device, gateway: { id: 7 } },
      }),
    ).toBe('queue:stub-pull:gateway:7');
    expect(plugin.initialQueueKey(deviceOnly)).toBe('queue:stub-pull:gateway:unassigned');
    expect(plugin.incoming.fetchStatus).toBeTypeOf('function');
    expect(plugin.incoming.handle).toBeUndefined();
    await expect(plugin.incoming.fetchStatus?.(sampleMessage)).resolves.toBeNull();
  });

  it('outgoing sendOne is a no-op that returns a stub external id', async () => {
    const plugin = createStubPlugin({
      id: 'custom-stub',
      deliveryPattern: 'PUSH',
      nodeKind: 'network',
      admission: { strategy: 'spacing', minIntervalMs: 1 },
    });
    await expect(plugin.outgoing.sendOne(sampleMessage)).resolves.toBe('stub-ext-id');
    expect(plugin.outgoing.getRemoteStatus(sampleMessage)).toEqual({
      deliveryStatus: 'QUEUED',
    });
    expect(plugin.outgoing.parseError(new Error('boom'))).toEqual({ reason: 'boom' });
    expect(plugin.initialQueueKey(deviceOnly)).toBe('queue:custom-stub:network:42');
  });
});
