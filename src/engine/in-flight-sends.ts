/**
 * @fileoverview The set of `sendOne` calls this process is still awaiting (ADR-008 §8).
 *
 * Two problems, one list. The `ns` stage deadline exists to catch a send that never returns,
 * but a slow send that *does* return is not a lost send — and firing the deadline on it is
 * how the same command reached hardware twice (**A3**). Under ADR-007 there is exactly one
 * writer, and that process knows which sends it still holds, so the `ns` action can ask.
 *
 * The same list is the seam graceful shutdown uses: send-and-transition
 * promises used to be anonymous, so there was nothing to await before closing Redis.
 *
 * In-memory on purpose. A process death loses the set, the deadline fires after restart, and
 * that is correct — the connection died with it. What it cannot know is whether the vendor
 * accepted the command first; that is an at-least-once boundary, named and accepted in the ADR.
 */

/** Registry of outstanding `sendOne` promises, keyed by message id. */
export type InFlightSends = {
  /**
   * Hold `messageId` in the set until `send` settles — the vendor call *and* the
   * stage move that follows it. The ns deadline asks {@link InFlightSends.has}
   * and must not fire while this process still owns that member (ADR-008 §8).
   *
   * Call it *with* the promise rather than around an async function, so
   * registration is synchronous: a tick that runs between starting the work and
   * awaiting it must already see the id.
   *
   * @param messageId - Message being sent
   * @param send - Already-started send-and-transition
   * @returns The same promise, so callers can `await` the tracked value
   */
  track<T>(messageId: string, send: Promise<T>): Promise<T>;
  /** Whether this process is still awaiting a send for this message. */
  has(messageId: string): boolean;
  /** How many sends are outstanding right now. */
  size(): number;
  /**
   * Wait until the set is empty, or `budgetMs` elapses.
   * A send tracked while this is waiting is included if time remains.
   *
   * @param budgetMs - How long to wait before abandoning the rest
   * @returns The number still outstanding when the budget ran out (`0` when all settled)
   */
  drain(budgetMs: number): Promise<number>;
};

/**
 * Create an in-flight send registry.
 *
 * One per process: the `ns` stage action and the sender must consult the same list, which is
 * why it is injected rather than module state.
 */
export function createInFlightSends(): InFlightSends {
  const sends = new Map<string, Promise<unknown>>();

  function track<T>(messageId: string, send: Promise<T>): Promise<T> {
    const tracked = send.finally(() => {
      if (sends.get(messageId) === tracked) sends.delete(messageId);
    });
    sends.set(messageId, tracked);
    return tracked;
  }

  function has(messageId: string): boolean {
    return sends.has(messageId);
  }

  function size(): number {
    return sends.size;
  }

  async function drain(budgetMs: number): Promise<number> {
    const deadline = Date.now() + budgetMs;

    while (sends.size > 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;

      const expired = new Promise<void>(resolve => {
        // `unref` so a drain never holds the process open past its own budget.
        setTimeout(resolve, remainingMs).unref();
      });
      // Swallow rejections: drain only waits, it must not throw.
      await Promise.race([
        Promise.all([ ...sends.values() ].map(pending => pending.catch(() => undefined))),
        expired,
      ]);
    }

    return sends.size;
  }

  return { track, has, size, drain };
}
