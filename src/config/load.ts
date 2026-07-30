import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deepFreeze } from './deep-freeze.js';
import { deviceMessagingConfigSchema, type DeviceMessagingConfig } from './schema.js';

const DEFAULT_CONFIG_FILENAME = 'config.default.json';

const ENV_CONFIG_JSON = 'DEVICE_MESSAGING_CONFIG_JSON';
const ENV_CONFIG_URL = 'DEVICE_MESSAGING_CONFIG_URL';
const ENV_CONFIG_PATH = 'DEVICE_MESSAGING_CONFIG_PATH';

export interface LoadConfigOptions {
  /**
   * Overrides the resolved path to the bundled default config. Intended for tests exercising
   * precedence order without depending on the real repo-root artifact.
   */
  defaultConfigPath?: string;
}

/**
 * Resolves, parses, validates, and freezes service configuration (ADR-002 §4).
 *
 * Precedence: `DEVICE_MESSAGING_CONFIG_JSON` → `DEVICE_MESSAGING_CONFIG_URL` →
 * `DEVICE_MESSAGING_CONFIG_PATH` → bundled `config.default.json`.
 *
 * Process boot exports the result from `src/runtime.ts` — this function does not store globals.
 */
export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<DeviceMessagingConfig> {
  const rawJson = await resolveRawConfig(options);
  const config = parseConfig(rawJson);
  return deepFreeze(config);
}

async function resolveRawConfig(options: LoadConfigOptions): Promise<string> {
  const inlineJson = process.env[ENV_CONFIG_JSON];
  if (inlineJson) {
    return inlineJson;
  }

  const configUrl = process.env[ENV_CONFIG_URL];
  if (configUrl) {
    return fetchConfigUrl(configUrl);
  }

  const configPath = process.env[ENV_CONFIG_PATH];
  if (configPath) {
    return readConfigFile(configPath);
  }

  return readConfigFile(options.defaultConfigPath ?? resolveDefaultConfigPath());
}

async function fetchConfigUrl(url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url);
  }
  catch (cause) {
    throw new Error(
      `Failed to fetch config from "${ url }": ${ (cause as Error).message }`,
      { cause },
    );
  }

  if (!response.ok) {
    throw new Error(
      `Failed to fetch config from "${ url }": HTTP ${ response.status } ${ response.statusText }`,
    );
  }

  return response.text();
}

function readConfigFile(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  }
  catch (cause) {
    throw new Error(
      `Failed to read config file at "${ path }": ${ (cause as Error).message }`,
      { cause },
    );
  }
}

function resolveDefaultConfigPath(): string {
  const bundleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(bundleDir, DEFAULT_CONFIG_FILENAME),
    join(process.cwd(), DEFAULT_CONFIG_FILENAME),
  ];

  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) {
    throw new Error(
      `Could not locate the bundled default config ("${ DEFAULT_CONFIG_FILENAME }"). Looked in: ${ candidates.join(', ') }`,
    );
  }
  return found;
}

function parseConfig(rawJson: string): DeviceMessagingConfig {
  let candidate: unknown;
  try {
    candidate = JSON.parse(rawJson);
  }
  catch (cause) {
    throw new Error(`Failed to parse config JSON: ${ (cause as Error).message }`, { cause });
  }

  const result = deviceMessagingConfigSchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues
      .map(issue => `  - ${ issue.path.join('.') || '(root)' }: ${ issue.message }`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${ issues }`);
  }

  return result.data;
}
