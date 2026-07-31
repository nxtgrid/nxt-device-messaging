import { describe, expect, it } from 'vitest';

import { createPluginRegistry } from '../../../src/plugins/registry.js';
import { STUB_PULL_ID, STUB_PUSH_ID } from '../../../src/plugins/stub/index.js';

describe('createPluginRegistry', () => {
  it('builds a lookup-only registry from config entries', () => {
    const registry = createPluginRegistry([
      { id: STUB_PUSH_ID },
      { id: STUB_PULL_ID },
    ]);
    expect(registry.getAll().map(plugin => plugin.id)).toEqual([
      STUB_PUSH_ID,
      STUB_PULL_ID,
    ]);
    expect(registry.get(STUB_PUSH_ID)?.deliveryPattern).toBe('PUSH');
    expect(registry.get(STUB_PULL_ID)?.deliveryPattern).toBe('PULL');
  });

  it('returns an empty registry when plugins[] is empty', () => {
    const registry = createPluginRegistry([]);
    expect(registry.getAll()).toEqual([]);
    expect(registry.get(STUB_PUSH_ID)).toBeUndefined();
  });

  it('filters by deliveryPattern', () => {
    const registry = createPluginRegistry([
      { id: STUB_PUSH_ID },
      { id: STUB_PULL_ID },
    ]);
    expect(registry.getByDeliveryPattern('PULL').map(plugin => plugin.id)).toEqual([
      STUB_PULL_ID,
    ]);
    expect(registry.getByDeliveryPattern('PUSH').map(plugin => plugin.id)).toEqual([
      STUB_PUSH_ID,
    ]);
  });

  it('throws on unknown plugin id', () => {
    expect(() => createPluginRegistry([ { id: 'calin-api-v2' } ])).toThrow(
      /Unknown plugin id "calin-api-v2"/,
    );
  });

  it('throws when the same id appears twice in config', () => {
    expect(() =>
      createPluginRegistry([ { id: STUB_PUSH_ID }, { id: STUB_PUSH_ID } ]),
    ).toThrow(/Duplicate plugin id/);
  });
});
