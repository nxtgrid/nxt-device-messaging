import { describe, expect, it } from 'vitest';

import {
  buildInitialQueueKey,
  pluginIdFromInitialQueueKey,
} from '../../../src/plugins/initial-queue-key.js';

describe('buildInitialQueueKey', () => {
  it('builds queue:{pluginId}:{kind}:{id}', () => {
    expect(buildInitialQueueKey('calin-chirpstack', 'network', '42')).toBe(
      'queue:calin-chirpstack:network:42',
    );
    expect(buildInitialQueueKey('stub-push', 'network', 'unassigned')).toBe(
      'queue:stub-push:network:unassigned',
    );
  });
});

describe('pluginIdFromInitialQueueKey', () => {
  it('extracts pluginId for distribute lookup', () => {
    expect(pluginIdFromInitialQueueKey('queue:calin-api-v1:gateway:7')).toBe(
      'calin-api-v1',
    );
    expect(pluginIdFromInitialQueueKey('queue:stub-pull:gateway:unassigned')).toBe(
      'stub-pull',
    );
  });

  it('returns undefined for malformed keys', () => {
    expect(pluginIdFromInitialQueueKey('')).toBeUndefined();
    expect(pluginIdFromInitialQueueKey('queue:only-two')).toBeUndefined();
    expect(pluginIdFromInitialQueueKey('lock_queue:queue:x:y:z')).toBeUndefined();
    expect(pluginIdFromInitialQueueKey('queue::network:1')).toBeUndefined();
  });
});
