/**
 * @fileoverview The set of `sendOne` calls this process is still awaiting (ADR-008 §8).
 *
 * Two problems, one list. The `ns` stage deadline exists to catch a send that never returns,
 * but a slow send that *does* return is not a lost send — and firing the deadline on it is
 * how the same command reached hardware twice (**A3**). Under ADR-007 there is exactly one
 * writer, and that process knows which sends it still holds, so the `ns` action can ask.
 *
 * The same list is the seam graceful shutdown never had: `sendOne` promises used to be
 * anonymous, so there was nothing to await before closing Redis.
 *
 * In-memory on purpose. A process death loses the set, the deadline fires after restart, and
 * that is correct — the connection died with it. What it cannot know is whether the vendor
 * accepted the command first; that is an at-least-once boundary, named and accepted in the ADR.
 */

/** Registry of outstanding `sendOne` promises, keyed by message id. */
export type InFlightSends = {
  /**
   * Register a send for as long as it runs. The id is present from this call until the
   * promise settles, either way.
   *
   * Call it *with* the promise rather than around an async function, so registration is
   * synchronous: a tick that runs between starting the send and awaiting it must already
   * see the id.
   *
   * @param messageId - Message being sent
   * @param send - The plugin call, already started
   * @returns The same promise, so callers can `await` the tracked value
   */
  track<T>(messageId: string, send: Promise<T>): Promise<T>;
  /** Whether this process is still awaiting a send for this message. */
  has(messageId: string): boolean;
  /** How many sends are outstanding right now. */
  size(): number;
  /**
   * Wait for the outstanding sends, up to a budget.
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
    if (sends.size === 0) return 0;

    const expired = new Promise<void>(resolve => {
      // `unref` so a drain never holds the process open past its own budget.
      setTimeout(resolve, budgetMs).unref();
    });
    // Swallow rejections: drain only waits, it must not throw.
    await Promise.race([
      Promise.all([ ...sends.values() ].map(pending => pending.catch(() => undefined))),
      expired,
    ]);

    return sends.size;
  }

  return { track, has, size, drain };
}
