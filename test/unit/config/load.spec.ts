import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '#src/config/index.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const FROM_PATH_FIXTURE = join(FIXTURES_DIR, 'from-path.config.json');
const FROM_DEFAULT_FIXTURE = join(FIXTURES_DIR, 'from-default.config.json');
const INVALID_SCHEMA_VERSION_FIXTURE = join(FIXTURES_DIR, 'invalid-schema-version.config.json');

const INLINE_JSON = JSON.stringify({
  $schemaVersion: '1',
  engine: { enabled: true },
  plugins: [ { id: 'from-json' } ],
});

const URL_JSON = JSON.stringify({
  $schemaVersion: '1',
  engine: { enabled: true },
  plugins: [ { id: 'from-url' } ],
});

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it('resolves from the bundled default when no env var is set', async () => {
    delete process.env.DEVICE_MESSAGING_CONFIG_JSON;
    delete process.env.DEVICE_MESSAGING_CONFIG_URL;
    delete process.env.DEVICE_MESSAGING_CONFIG_PATH;

    const config = await loadConfig({ defaultConfigPath: FROM_DEFAULT_FIXTURE });

    expect(config.engine.enabled).toBe(true);
    expect(config.plugins).toEqual([]);
  });

  it('prefers DEVICE_MESSAGING_CONFIG_PATH over the bundled default', async () => {
    delete process.env.DEVICE_MESSAGING_CONFIG_JSON;
    delete process.env.DEVICE_MESSAGING_CONFIG_URL;
    process.env.DEVICE_MESSAGING_CONFIG_PATH = FROM_PATH_FIXTURE;

    const config = await loadConfig({ defaultConfigPath: FROM_DEFAULT_FIXTURE });

    expect(config.engine.enabled).toBe(false);
    expect(config.plugins[0]?.id).toBe('from-path');
  });

  it('prefers DEVICE_MESSAGING_CONFIG_URL over PATH and the bundled default', async () => {
    delete process.env.DEVICE_MESSAGING_CONFIG_JSON;
    process.env.DEVICE_MESSAGING_CONFIG_URL = 'https://example.test/config.json';
    process.env.DEVICE_MESSAGING_CONFIG_PATH = FROM_PATH_FIXTURE;

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(URL_JSON, { status: 200 })),
    );

    const config = await loadConfig({ defaultConfigPath: FROM_DEFAULT_FIXTURE });

    expect(config.plugins[0]?.id).toBe('from-url');
  });

  it('prefers DEVICE_MESSAGING_CONFIG_JSON over URL, PATH, and the bundled default', async () => {
    process.env.DEVICE_MESSAGING_CONFIG_JSON = INLINE_JSON;
    process.env.DEVICE_MESSAGING_CONFIG_URL = 'https://example.test/config.json';
    process.env.DEVICE_MESSAGING_CONFIG_PATH = FROM_PATH_FIXTURE;

    const config = await loadConfig({ defaultConfigPath: FROM_DEFAULT_FIXTURE });

    expect(config.plugins[0]?.id).toBe('from-json');
  });

  it('rejects a $schemaVersion mismatch with a clear, path-based error', async () => {
    delete process.env.DEVICE_MESSAGING_CONFIG_JSON;
    delete process.env.DEVICE_MESSAGING_CONFIG_URL;
    process.env.DEVICE_MESSAGING_CONFIG_PATH = INVALID_SCHEMA_VERSION_FIXTURE;

    await expect(loadConfig({ defaultConfigPath: FROM_DEFAULT_FIXTURE }))
      .rejects
      .toThrow(/\$schemaVersion/);
  });

  it('freezes the resolved configuration', async () => {
    delete process.env.DEVICE_MESSAGING_CONFIG_JSON;
    delete process.env.DEVICE_MESSAGING_CONFIG_URL;
    delete process.env.DEVICE_MESSAGING_CONFIG_PATH;

    const config = await loadConfig({ defaultConfigPath: FROM_DEFAULT_FIXTURE });

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.engine)).toBe(true);
  });

  it('applies delivery defaults when omitted', async () => {
    delete process.env.DEVICE_MESSAGING_CONFIG_JSON;
    delete process.env.DEVICE_MESSAGING_CONFIG_URL;
    delete process.env.DEVICE_MESSAGING_CONFIG_PATH;

    const config = await loadConfig({ defaultConfigPath: FROM_DEFAULT_FIXTURE });

    expect(config.delivery.maxRetries).toBe(11);
    expect(config.delivery.retryBaseDelayMs).toBe(2000);
    expect(config.delivery.retryBackoffMultiplier).toBe(2);
    expect(config.delivery.retryMaxDelayMs).toBe(3_600_000);
    expect(config.delivery.messageTtlSeconds).toBe(604_800);
  });

  it('applies eventWebhook tuning defaults when only url is set', async () => {
    process.env.DEVICE_MESSAGING_CONFIG_JSON = JSON.stringify({
      $schemaVersion: '1',
      eventWebhook: { url: 'https://consumer.example/hooks/device-messages' },
      plugins: [],
    });

    const config = await loadConfig({ defaultConfigPath: FROM_DEFAULT_FIXTURE });

    expect(config.eventWebhook?.url).toBe('https://consumer.example/hooks/device-messages');
    expect(config.eventWebhook?.maxAttempts).toBe(6);
    expect(config.eventWebhook?.baseDelayMs).toBe(2000);
    expect(config.eventWebhook?.backoffMultiplier).toBe(2);
    expect(config.eventWebhook?.maxDelayMs).toBe(60_000);
    expect(config.eventWebhook?.requestTimeoutMs).toBe(10_000);
    expect(config.eventWebhook?.deadLetterTtlSeconds).toBe(604_800);
  });

  it('rejects backoff multipliers below 1', async () => {
    process.env.DEVICE_MESSAGING_CONFIG_JSON = JSON.stringify({
      $schemaVersion: '1',
      eventWebhook: {
        url: 'https://consumer.example/hooks/device-messages',
        backoffMultiplier: 0.5,
      },
      plugins: [],
    });

    await expect(loadConfig({ defaultConfigPath: FROM_DEFAULT_FIXTURE }))
      .rejects
      .toThrow(/backoffMultiplier/);
  });
});
