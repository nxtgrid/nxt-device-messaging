/**
 * @fileoverview The outer bound on any vendor HTTP call (ADR-008 §8).
 *
 * Not a timeout in the usual sense. Timeliness is the stage deadline's job — it decides when
 * a send has taken too long and retries it. This one exists so that a `sendOne` promise
 * always *settles*: the `ns` stage extends its deadline for as long as this process is still
 * awaiting the send, so a request that hangs forever would keep its message alive forever.
 *
 * Hence the size. At 120 s it is an order of magnitude above the 20 s stage deadline and far
 * past any defensible vendor latency (the worst observed is 37 s), so it never truncates a
 * healthy slow call. Aborting closer to the stage deadline was considered and rejected in the
 * ADR: cutting the connection after the vendor has already accepted the command is how the
 * same command reaches hardware twice, which is the failure this whole mechanism removes.
 */

/** Milliseconds before a vendor HTTP call is abandoned so its promise settles. */
export const CLIENT_SAFETY_DEADLINE_MS = 120_000;
