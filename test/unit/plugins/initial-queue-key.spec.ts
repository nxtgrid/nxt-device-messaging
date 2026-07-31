import { describe, expect, it } from 'vitest';

import {
  buildInitialQueueKey,
  getPluginIdFromInitialQueueKey,
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

describe('getPluginIdFromInitialQueueKey', () => {
  it('extracts pluginId for distribute lookup', () => {
    expect(getPluginIdFromInitialQueueKey('queue:calin-api-v1:gateway:7')).toBe(
      'calin-api-v1',
    );
    expect(getPluginIdFromInitialQueueKey('queue:stub-pull:gateway:unassigned')).toBe(
      'stub-pull',
    );
  });

  it('returns undefined for malformed keys', () => {
    expect(getPluginIdFromInitialQueueKey('')).toBeUndefined();
    expect(getPluginIdFromInitialQueueKey('queue:only-two')).toBeUndefined();
    expect(getPluginIdFromInitialQueueKey('lock_queue:queue:x:y:z')).toBeUndefined();
    expect(getPluginIdFromInitialQueueKey('queue::network:1')).toBeUndefined();
  });
});
