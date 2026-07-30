/**
 * @fileoverview Known plugin factories (id → construct).
 *
 * Config `plugins[].id` must appear here. I1: stubs only. Phase 2 / Unit 6 adds real
 * adapters. Each factory receives that plugin's config entry (settings/tuning; secrets
 * stay in env). Dynamic import of unused plugins is deferred until those units.
 */

import type { DeviceMessagingConfig } from '../config/schema.js';
import type { DeviceMessagingPlugin } from './plugin.interface.js';
import {
  createStubPullPlugin,
  createStubPushPlugin,
  STUB_PULL_ID,
  STUB_PUSH_ID,
} from './stub/index.js';

/** Catalog of constructible plugins shipped with this service. */
export const PLUGIN_CATALOG: Record<
  string,
  (entry: DeviceMessagingConfig['plugins'][number]) => DeviceMessagingPlugin
> = {
  [ STUB_PUSH_ID ]: createStubPushPlugin,
  [ STUB_PULL_ID ]: createStubPullPlugin,
};
