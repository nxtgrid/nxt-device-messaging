/**
 * @fileoverview Known plugin factories (id → construct).
 *
 * Config `plugins[].id` must appear here. Each factory receives that plugin's
 * config entry (settings/tuning; secrets stay in env) and merges tuning onto
 * code defaults. Units 9–10 add remaining adapters to this map.
 */

import type { DeviceMessagingConfig } from '../config/schema.js';
import type { DeviceMessagingPlugin } from './plugin.interface.js';

import {
  CALIN_API_V1_ID,
  createCalinApiV1Plugin,
} from './calin-api-v1/index.js';
import {
  NXT_STS_ID,
  createNxtStsPlugin,
} from './nxt-sts/index.js';
import {
  STUB_PUSH_ID,
  createStubPushPlugin,
  STUB_PULL_ID,
  createStubPullPlugin,
} from './stub/index.js';

/** Catalog of constructible plugins shipped with this service. */
export const PLUGIN_CATALOG: Record<
  string,
  (entry: DeviceMessagingConfig['plugins'][number]) => DeviceMessagingPlugin
> = {
  [ CALIN_API_V1_ID ]: createCalinApiV1Plugin,
  [ NXT_STS_ID ]: createNxtStsPlugin,
  [ STUB_PUSH_ID ]: createStubPushPlugin,
  [ STUB_PULL_ID ]: createStubPullPlugin,
};
