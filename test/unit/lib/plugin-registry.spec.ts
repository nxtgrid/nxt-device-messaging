import { describe, expect, it, beforeEach } from 'vitest';
import type { DeviceMessagingPlugin } from '../../../src/lib/plugin.interface.js';
import { createPluginRegistry } from '../../../src/lib/plugin-registry.js';
import type { BottleneckKeyInput } from '../../../src/lib/plugin.interface.js';
import type { DeviceMessage, FailureContext } from '../../../src/lib/types.js';

function stubPlugin(
  id: string,
  deliveryPattern: DeviceMessagingPlugin['deliveryPattern'],
): DeviceMessagingPlugin {
  return {
    id,
    deliveryPattern,
    bottleneckKey: (_input: BottleneckKeyInput) => `queue:test:${ id }`,
    admission: { strategy: 'spacing', minIntervalMs: 2000 },
    outgoing: {
      sendOne: async (_message: DeviceMessage) => 'ext-1',
      getRemoteStatus: () => ({ delivery_status: 'QUEUED' }),
      parseError: (_err: unknown): FailureContext => ({ reason: 'stub' }),
    },
    incoming: {},
  };
}

describe('pluginRegistry', () => {
  const registry = createPluginRegistry();

  beforeEach(() => {
    registry.clear();
  });

  it('registers and returns a plugin by id', () => {
    const plugin = stubPlugin('calin-api-v1', 'PULL');
    registry.register(plugin);
    expect(registry.get('calin-api-v1')).toBe(plugin);
  });

  it('throws when registering a duplicate id', () => {
    registry.register(stubPlugin('calin-api-v1', 'PULL'));
    expect(() => registry.register(stubPlugin('calin-api-v1', 'PULL'))).toThrow(
      /already registered/i,
    );
  });

  it('lists all plugins in registration order', () => {
    registry.register(stubPlugin('a', 'PUSH'));
    registry.register(stubPlugin('b', 'PULL'));
    expect(registry.getAll().map(plugin => plugin.id)).toEqual([ 'a', 'b' ]);
  });

  it('filters by deliveryPattern', () => {
    registry.register(stubPlugin('push-1', 'PUSH'));
    registry.register(stubPlugin('pull-1', 'PULL'));
    registry.register(stubPlugin('pull-2', 'PULL'));
    expect(registry.getByDeliveryPattern('PULL').map(plugin => plugin.id)).toEqual([
      'pull-1',
      'pull-2',
    ]);
    expect(registry.getByDeliveryPattern('PUSH').map(plugin => plugin.id)).toEqual([ 'push-1' ]);
  });
});
