/**
 * @fileoverview In-memory Redis surface for queue-depth tests (no Valkey).
 */

import type { QueueDepthRedis } from '#src/metrics/queue-depth.js';

export type FakeQueueDepthState = {
  members: string[];
  cards: Record<string, number>;
};

/** Mutable fake: `smembers` / `ZCARD` read `state` on each scrape. */
export function createFakeQueueDepthRedis(
  state: FakeQueueDepthState = { members: [], cards: {} },
): QueueDepthRedis {
  return {
    smembers: async () => [ ...state.members ],
    pipeline() {
      const keys: string[] = [];
      const pipeline = {
        zcard(key: string) {
          keys.push(key);
          return pipeline;
        },
        async exec(): Promise<[Error | null, unknown][] | null> {
          return keys.map(key => [ null, state.cards[key] ?? 0 ]);
        },
      };
      return pipeline;
    },
  };
}
