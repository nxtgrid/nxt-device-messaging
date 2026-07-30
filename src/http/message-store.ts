/**
 * @fileoverview In-memory message store for Intermezzo I2 (replaced by Redis in I3).
 */

import type { DeviceMessage } from '../lib/types.js';

/** Minimal store: one message per correlation id (last write wins). */
export type MessageStore = {
  set(correlationId: string, message: DeviceMessage): void;
  get(correlationId: string): DeviceMessage | undefined;
};

/** Creates a process-local Map-backed store. */
export function createMessageStore(): MessageStore {
  const messages = new Map<string, DeviceMessage>();

  return {
    set(correlationId: string, message: DeviceMessage): void {
      messages.set(correlationId, message);
    },

    get(correlationId: string): DeviceMessage | undefined {
      return messages.get(correlationId);
    },
  };
}
