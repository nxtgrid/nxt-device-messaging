import { describe, expect, it } from 'vitest';

import { bottleneckKindFromQueueKey } from '../../../src/plugins/bottleneck-kind.js';

describe('bottleneckKindFromQueueKey', () => {
  it('extracts the kind from queue:{kind}:{id}', () => {
    expect(bottleneckKindFromQueueKey('queue:stub_network:42')).toBe('stub_network');
    expect(bottleneckKindFromQueueKey('queue:stub_gateway:unassigned')).toBe('stub_gateway');
  });

  it('keeps only the first segment after queue as kind (id may contain :)', () => {
    expect(bottleneckKindFromQueueKey('queue:lorawan_network:unassigned')).toBe(
      'lorawan_network',
    );
  });

  it('returns undefined for malformed keys', () => {
    expect(bottleneckKindFromQueueKey('')).toBeUndefined();
    expect(bottleneckKindFromQueueKey('stub_network:42')).toBeUndefined();
    expect(bottleneckKindFromQueueKey('queue:')).toBeUndefined();
    expect(bottleneckKindFromQueueKey('queue:stub_network')).toBeUndefined();
    expect(bottleneckKindFromQueueKey('lock_queue:queue:stub_network:1')).toBeUndefined();
  });
});
