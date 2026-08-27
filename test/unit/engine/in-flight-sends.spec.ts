import { describe, expect, it } from 'vitest';

import { createInFlightSends } from '#src/engine/in-flight-sends.js';

/** A promise plus the handles to settle it, so a test can hold a send open. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
  } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createInFlightSends', () => {
  it('holds the id from the call until the promise settles', async () => {
    const inFlight = createInFlightSends();
    const send = deferred<string>();

    const tracked = inFlight.track('msg-1', send.promise);
    expect(inFlight.has('msg-1')).toBe(true);

    send.resolve('ext-1');
    await expect(tracked).resolves.toBe('ext-1');
    expect(inFlight.has('msg-1')).toBe(false);
  });

  it('releases the id when the send throws, and still gives the caller the error', async () => {
    const inFlight = createInFlightSends();
    const send = deferred<string>();

    const tracked = inFlight.track('msg-2', send.promise);
    send.reject(new Error('vendor down'));

    await expect(tracked).rejects.toThrow('vendor down');
    expect(inFlight.has('msg-2')).toBe(false);
  });

  it('drains to zero once every send settles', async () => {
    const inFlight = createInFlightSends();
    const first = deferred<string>();
    const second = deferred<string>();

    void inFlight.track('msg-3', first.promise).catch(() => undefined);
    void inFlight.track('msg-4', second.promise).catch(() => undefined);
    expect(inFlight.size()).toBe(2);

    first.resolve('ext-3');
    second.reject(new Error('vendor down'));

    // A rejected send must not fail the drain — it settled, which is all shutdown needs.
    await expect(inFlight.drain(1_000)).resolves.toBe(0);
  });

  it('reports what it abandoned when the budget runs out', async () => {
    const inFlight = createInFlightSends();
    const stuck = deferred<string>();

    void inFlight.track('msg-5', stuck.promise);

    await expect(inFlight.drain(10)).resolves.toBe(1);

    stuck.resolve('ext-5');
  });

  it('drains immediately when nothing is in flight', async () => {
    const inFlight = createInFlightSends();

    await expect(inFlight.drain(60_000)).resolves.toBe(0);
  });

  it('keeps waiting for a send tracked after the current snapshot', async () => {
    const inFlight = createInFlightSends();
    const first = deferred<string>();
    const late = deferred<string>();

    void inFlight.track('msg-6', first.promise);
    const drained = inFlight.drain(1_000);
    void inFlight.track('msg-7', late.promise);
    first.resolve('ext-6');

    const stillWaiting = await Promise.race([
      drained.then(() => false),
      new Promise<boolean>(resolve => {
        setTimeout(() => resolve(true), 30);
      }),
    ]);
    expect(stillWaiting).toBe(true);
    expect(inFlight.size()).toBe(1);

    late.resolve('ext-7');
    await expect(drained).resolves.toBe(0);
  });
});
