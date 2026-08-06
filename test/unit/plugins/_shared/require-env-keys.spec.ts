import { afterEach, describe, expect, it, vi } from 'vitest';

import { requireEnvKeys } from '#src/plugins/_shared/require-env-keys.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('requireEnvKeys', () => {
  it('returns trimmed values for present keys', () => {
    vi.stubEnv('FOO_URL', '  https://example  ');
    vi.stubEnv('FOO_TOKEN', 'secret');
    expect(requireEnvKeys('foo', [ 'FOO_URL', 'FOO_TOKEN' ] as const)).toEqual({
      FOO_URL: 'https://example',
      FOO_TOKEN: 'secret',
    });
  });

  it('throws MISSING naming the plugin and blank keys', () => {
    vi.stubEnv('FOO_URL', '');
    vi.stubEnv('FOO_TOKEN', '   ');
    expect(() => requireEnvKeys('foo', [ 'FOO_URL', 'FOO_TOKEN' ] as const)).toThrow(
      'MISSING env for plugin "foo": FOO_URL, FOO_TOKEN',
    );
  });

  it('lists only the missing keys when some are present', () => {
    vi.stubEnv('FOO_URL', 'https://example');
    expect(() => requireEnvKeys('foo', [ 'FOO_URL', 'FOO_TOKEN' ] as const)).toThrow(
      'MISSING env for plugin "foo": FOO_TOKEN',
    );
  });
});
