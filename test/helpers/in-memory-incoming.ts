/**
 * @fileoverview In-memory {@link IncomingService} for HTTP unit tests (no Valkey).
 */

import type { IncomingService } from '#src/engine/incoming.js';
import type { StageOutcome } from '#src/engine/lifecycle/types.js';
import type {
  ParsedIncomingEvent,
} from '#src/lib/device-message/types.js';
import type {
  DeliveryPlugin,
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
    async processEvent(
      _parsedEvent: ParsedIncomingEvent,
      _queueKey: string,
      _plugin: DeliveryPlugin,
    ): Promise<StageOutcome> {
      // HTTP unit tests do not exercise poll / processEvent.
      return 'movedOn';
    },
  };
}
