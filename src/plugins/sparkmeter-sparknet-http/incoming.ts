/**
 * @fileoverview `sparkmeter-sparknet-http` incoming facet.
 *
 * PUSH requires `handle` today. The event stream is a later checklist item,
 * so ingress ignores every body until then.
 */

import type { ParsedIncomingEvent } from '../../lib/device-message/types.js';
import type { PushPlugin } from '../plugin.interface.js';

/** Ingress parser that drops every event. */
export function createSparkmeterSparknetHttpIncoming(): PushPlugin['incoming'] {
  return {
    handle(_event: unknown): ParsedIncomingEvent | null {
      return null;
    },
  };
}
