import { describe, expect, it } from 'vitest';

import {
  buildConcurrencyRateLimitKey,
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
    expect(getPluginIdFromInitialQueueKey('queue:calin-api-v1:dcu:7')).toBe(
      'calin-api-v1',
    );
    expect(getPluginIdFromInitialQueueKey('queue:stub-pull:relayNode:unassigned')).toBe(
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

describe('buildConcurrencyRateLimitKey', () => {
  it('maps queue:… to rate_limit:… for the same admission node', () => {
    expect(buildConcurrencyRateLimitKey('queue:stub-pull:relayNode:7')).toBe(
      'rate_limit:stub-pull:relayNode:7',
    );
    expect(buildConcurrencyRateLimitKey('queue:calin-api-v1:dcu:unassigned')).toBe(
      'rate_limit:calin-api-v1:dcu:unassigned',
    );
  });

  it('returns undefined for malformed keys', () => {
    expect(buildConcurrencyRateLimitKey('queue:only-two')).toBeUndefined();
    expect(buildConcurrencyRateLimitKey('rate_limit:stub-pull:relayNode:7')).toBeUndefined();
  });
});
