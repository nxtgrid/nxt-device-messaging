/**
 * @fileoverview In-memory {@link IncomingService} for HTTP unit tests (no Valkey).
 */

import type { IncomingService } from '#src/engine/incoming.js';
import type {
  IncomingHandleMeta,
  PushPlugin,
} from '#src/plugins/plugin.interface.js';

export type InMemoryIncomingServiceOptions = {
  /** Optional spy — called with the resolved plugin from the route. */
  readonly onHandle?: (
    event: unknown,
    plugin: PushPlugin,
    meta?: IncomingHandleMeta,
  ) => void | Promise<void>;
};

/** Process-local incoming for route / app unit tests. */
export function createInMemoryIncomingService(
  options: InMemoryIncomingServiceOptions = {},
): IncomingService {
  return {
    async handle(
      event: unknown,
      plugin: PushPlugin,
      meta?: IncomingHandleMeta,
    ): Promise<void> {
      await options.onHandle?.(event, plugin, meta);
    },
    async pollPullPlugins(): Promise<void> {
      // no-op — HTTP unit tests do not exercise poll
    },
  };
}
