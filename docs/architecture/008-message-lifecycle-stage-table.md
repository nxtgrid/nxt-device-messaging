# ADR-008: The message lifecycle is a stage table

**Date:** 2026-08-20
**Status:** Accepted

> Replaces a hand-written lifecycle — six scan sites, two pattern-specific file pairs, and
> two interval timers — with **one declarative table of stages** and **one runner** that
> drives it. Redis key layout is unchanged. This is a code-organisation decision that also
> closes four correctness gaps, because each of those gaps is a rule that had no single home.
>
> **Amendment (2026-08-26):** `SIGTERM`/`SIGINT` stop the enqueue distribute kick, then drain
> the in-flight set (20 s). See ADR-005. Awaiting the webhook `drainChain` stays parked
> (`docs/decisions-log.md`).

**Read this when:** touching delivery stages, timeouts, polling, retry, cleanup, or the engine
tick; adding a plugin whose delivery flow does not fit PUSH or PULL; or wondering why a
`queue_*` key exists.
**Related:** ADR-006 (admission and the ready queue), ADR-007 (single writer — decision 7
depends on it), ADR-001 (factory + closure DI), `nxt-backend` ADR-001 (PUSH/PULL divergence),
`docs/plans/002-architecture-review.md` (findings A1–A5, B3, C1, C2).

---

## Context

A message crosses as many as five Redis sorted sets between enqueue and exit. Which sets, what the
score means, which delivery status goes with each, what happens on timeout, and what happens on
success are all real properties of the lifecycle — and none of them is written down in one
place. They are distributed across `engine/outgoing.ts` (`runMessageResolutionCycle`'s five
hand-written steps), `engine/incoming.ts` (`_processIncomingEvent`), `lib/queue-moving.ts`,
`lib/queue-moving.push.ts`, `lib/queue-moving.pull.ts`, `lib/lifecycle.push.ts`, and
`lib/lifecycle.pull.ts`.

The cost is not aesthetic. Four of the review's five correctness findings are the same defect:
a rule that must hold at every stage, implemented by hand per stage, and forgotten somewhere.

| Finding | The rule with no single home | Held at |
|---|---|---|
| **A1** | An id whose hash is gone must be scrubbed from its queue | 3 of 5 scan sites |
| **A2** | A poll attempt always advances the next-poll score | 1 of 5 branches |
| **A3** | A stage transition can fail, and the caller must handle that | 0 of 2 call sites |
| **A4** | Cleanup removes every reference | 4 keys of 7 |

A3 is the one with teeth: a `sendOne` that outlives `nsInFlightTimeoutMs` (observed against
CALIN at 37 s, against a 20 s deadline) races the resolution cycle. The cycle has already moved
the message to retry, the post-send move silently fails, no `idx:external_delivery_id` is
written, and the command is sent to the meter a second time. For `TOP_UP_KWH` or `TURN_OFF`
that is a duplicate physical action.

Fixing these four as local patches means roughly a dozen new hand-written guards — one more
copy of each rule, in the same shape that produced the bugs.

---

## Decisions

### 1. The Redis layout does not change

Same keys, same members, same score meanings, same TTLs. `redis-cli --scan` output is identical
before and after; there is no migration and nothing for an operator to relearn. This is what
makes the change verifiable against the existing integration suite and revertible in one commit.

### 2. There are two kinds of queue, not six

| Kind | Score | Who drains it |
|---|---|---|
| **Ready queue** — `queue:{pluginId}:{kind}:{id}` | `-priority` | Distribution, under plugin admission (ADR-006) |
| **Scheduled stage** — the five keys in decision 3 | *The time the engine should next pay attention* | The runner (decision 6) |

The split is forced by Redis: a sorted set has one score, and the ready queue spends it on
priority. That is *why* `queue_awaiting_retry` exists as a separate key rather than as a future
score on the ready queue — and it is the whole reason the two kinds cannot be unified.

The ready queue is therefore **not** a row in the stage table. It is the pipeline's entry point,
and admission is its own concern (ADR-006).

### 3. A deadline and a next-poll time are the same thing

This is the insight the table encodes. `queue_in_flight_to_ns` scores a deadline;
`queue_awaiting_task:{pluginId}` scores a next-poll time. Both mean *"come back to this member
at time T"*. They differ only in the action attached, and an action is data.

The table has five rows:

| Stage | Redis key | Status on entry | Score on entry | Action when due |
|---|---|---|---|---|
| `ns` | `queue_in_flight_to_ns` | `SENT_TO_NS` | `now + tuning.nsInFlightTimeoutMs` | Timeout → `retryOrFail`, unless the send is still in flight (decision 8) |
| `relayNode` | `queue_in_flight_to_relay_node` | `DELIVERED_TO_NS` | `now + tuning.relayNodeInFlightTimeoutMs` | Ask `outgoing.getRemoteStatus`; still queued remotely → reschedule, else `retryOrFail` |
| `device` | `queue_in_flight_to_device` | `SENT_TO_DEVICE` | `now + tuning.deviceInFlightTimeoutMs` | Timeout → `retryOrFail` |
| `awaitingTask` | `queue_awaiting_task:{pluginId}` | `DELIVERED_TO_NS` | `now + tuning.initialPollDelayMs` | Poll `incoming.fetchStatus`; resolve, or reschedule on the poll ladder (decision 9) |
| `retry` | `queue_awaiting_retry` | `TO_RETRY` | `now + calculateBackoffDelay(...)` | Requeue to the plugin's ready queue |

`retry` is a stage but is **not** on a pipeline: it is reachable from any stage, and its exit is
backwards, to the ready queue. Pipelines describe only the forward path.

### 4. Pipelines are data, derived from the delivery pattern

```ts
const PIPELINES = {
  PUSH: ['ns', 'relayNode', 'device'],
  PULL: ['ns', 'awaitingTask'],
} as const satisfies Record<'PUSH' | 'PULL', readonly StageName[]>;
```

Keyed on `'PUSH' | 'PULL'`, not on `DeliveryPattern` — `'NONE'` (token-only, ADR-003 / C3) has
no pipeline, because those plugins never enqueue.

This is **Option A**: two fixed pipelines owned by core. Per-plugin pipelines are designed in
§ *Upgrade path* and deliberately not built. The choice of a lookup rather than
`if (pattern === 'PULL')` is what keeps that upgrade a one-line `??`.

### 5. `onDue` returns an outcome; the runner owns scrubbing and rescheduling

```ts
type StageOutcome =
  | 'rescheduled'  // still waiting here; the runner writes a new score from the row
  | 'movedOn'      // the action moved it to another stage or queue
  | 'removed'      // terminal; the action cleaned up and the member is gone
  | 'orphaned';    // the message hash vanished under us
```

The runner, not the action, performs the ZADD and the ZREM:

```ts
const due = await zrangebyscore(key, '-inf', now, 'LIMIT', 0, QUEUE_SCAN_BATCH_SIZE);
for (const id of due) {
  const message = await load(id);
  if (!message) { await zrem(key, id); continue; }        // A1 — stated once
  const outcome = await onDue({ message, plugin, stage });
  if (outcome === 'rescheduled') {                        // A2 — stated once
    await zaddXX(key, now + rescheduleWaitMsFor(stage, { message, now, tuning, delivery }), id);
  }
  if (outcome === 'orphaned') await zrem(key, id);
}
```

**This is the mechanism, not a convention.** An action that returns nothing is a type error, and
every variant maps to a definite runner obligation, so a stage added later cannot forget either
rule. A1 and A2 stop being bugs that were fixed and become states that are unrepresentable.

Note what the outcome does *not* carry: a time. An action reports *that* a message is still
waiting; the stage row decides *how long*, through `entryWaitMs` and — only where the wait is
dynamic — `rescheduleWaitMs`. So "poll this vendor again too soon" is not something an action can
express, which is A2's failure mode one layer up. Every reschedule in the system resolves through
one helper: the NS extension while a send is in flight (§8), the relay-node extension when the
vendor says the command is still queued, the PULL poll ladder, and the runner's own catch below.

Two supporting requirements follow:

- `retryOrFail` and the shared incoming-event processor must **return** an outcome rather than
  `void`, since both decide between "moved to retry" and "cleaned up".
- The runner catches a throwing action and treats it as `rescheduled` at the stage's normal
  wait, logged and counted. A vendor error must not leave a score unadvanced (A2 again) and must
  not abandon the rest of the batch. Actions must therefore be safe to re-run; the ZREM gate in
  `move-message-between-queues.lua` is what makes that true.

### 6. The table owns the edges, and there is exactly one `advance`

Every stage-to-stage move goes through one function that reads
`pipeline[indexOf(current) + 1]`, computes the destination score from that stage's definition,
and performs the ZREM-gated Lua move. It **returns whether the claim succeeded**.

Today that edge lives as an `if (plugin.deliveryPattern === 'PULL')` inside
`_sendOneToNetworkServer` (`outgoing.ts:223`), and neither branch reads its boolean result —
which is exactly where A3 hides. With the edge in the table there is one place that can report
"the move failed because someone else already claimed this message", and it reports it with a
counter rather than a dropped value.

### 7. Cleanup and every other stage enumeration derive from the table

`messageFullCleanup` today ZREMs three literal keys plus `queue_awaiting_task:{pluginId}` and
misses `queue_awaiting_retry` and the plugin's ready queue (A4). The metrics module keeps a
second literal list (`metrics/queue-depth.ts` `KNOWN_STAGE_KEYS`) that has already drifted from
it. Both become derived: **core stage keys + the awaiting-task key of every enabled PULL plugin
+ the message's ready queue**.

Deriving the ready-queue key needs the plugin, so cleanup takes the plugin (or the resolved key)
as an argument. That is a signature change and a first, small pull toward **C1**.

`queues_to_distribute_from` is deliberately *not* cleaned up per message: it holds queue keys,
not message ids, and `fetch-next-message-in-queue.lua` garbage-collects a key when its queue
empties. Removing it on cleanup would evict a queue that still has other messages.

### 8. The NS deadline does not fire while this process is still holding the send

The `ns` stage deadline exists to catch a `sendOne` that never returns. But under ADR-007 there
is exactly one writer, and that process *knows* whether it is still awaiting the promise. So the
`ns` action consults an in-memory set of message ids with an in-flight `sendOne`: still in
flight → `rescheduled` at `now + nsInFlightTimeoutMs`; otherwise → `retryOrFail` as today.

This is the same shape as the existing relay-node extension via `getRemoteStatus`, which is why
it costs one stage action rather than a mechanism. It makes A3's duplicate command structurally
unreachable in the common case: no retry can be scheduled while we are still waiting, so when
the slow send lands, its move succeeds and the external id is indexed.

**Accepted residue.** If the process dies mid-send, the set dies with it and the deadline fires
after restart, which is correct — the connection is gone. But the vendor may have accepted the
command before the process died. That is a genuine at-least-once boundary and cannot be closed
without a durable "send attempted" marker; it is not closed here. Decision 6's counter is what
makes any remaining occurrence visible instead of silent.

**Dependency: `sendOne` must eventually settle.** Extending the deadline while a send is
outstanding means a request that hangs forever keeps a message alive forever. `calin-api-v1`'s
client sets no fetch deadline at all today. So this decision carries one: **every plugin's
outbound client gets a safety deadline of 120 s** — an order of magnitude above the 20 s stage
deadline and far beyond any defensible vendor latency, so it never truncates a healthy slow call
(the observed worst case is 37 s). It exists to guarantee the promise settles, not to enforce
timeliness; enforcing timeliness is what the stage deadline is for, and doing it in the client
is rejected below. This unparks the fetch-deadline half of the *Plugin HTTP hygiene* row in
`docs/decisions-log.md`; the redaction and status-mapping halves stay parked.

**The set is also the seam graceful shutdown needs.** Distribute tracks each `sendOne` on the
in-flight set. Shutdown is: stop the timers so no new send starts, stop kicking distribute after
enqueue (the command is still stored; the next boot's tick picks it up), await the outstanding
sends against a budget (`drainInFlightSends`), **then** close Redis and Fastify — in that order,
because a send landing during the drain still has to write its external id and move stage, and
closing Redis first would recreate the very failure this decision removes.

The budget is an ops number, not the 120 s above: a typical Kubernetes termination grace of 30 s
means draining for something like 15–20 s and then abandoning the rest, which is the residue
already described. `SIGTERM`/`SIGINT` wiring landed 2026-08-26 (ADR-005). Awaiting the webhook
`drainChain` is a separate parked leftover (`docs/decisions-log.md`).

### 9. The PULL age cap becomes a property of the `awaitingTask` stage

Today a separate scan (`getPullTimeouts`) ZRANGEs the *entire* awaiting-task queue every cycle
and fails anything older than 48 hours. Under the table the age check moves into the
`awaitingTask` action: due, and older than the cap → emit the terminal event, clean up, return
`removed`.

Two consequences, both wanted. The per-tick full-queue scan disappears, replaced by a check on
members that were due anyway. And because the poll ladder caps at 30 s, a message is caught
within 30 s of its 48-hour mark rather than within one cycle — an irrelevant difference against
a two-day cap.

### 10. One tick at 1000 ms; stages run concurrently, members sequentially

One interval replaces the 2 s resolution cycle and the 5 s PULL poll. Punctuality error is
bounded by the interval, the shortest meaningful wait in the system is `retryBaseDelayMs`
(2000 ms), an idle tick is a handful of `ZRANGEBYSCORE … LIMIT 50` calls per second, and
`WEBHOOK_DRAIN_INTERVAL_MS` is already `1_000` — so the process ends up with one cadence instead
of three numbers.

Within a tick, stage rows are driven **concurrently** and members within a row **sequentially**.
Concurrency across rows is not an optimisation: it preserves today's behaviour, where a slow
`fetchStatus` cannot delay NS timeouts because the two live on different intervals. Collapsing
to one tick without it would serialise them.

Each row carries its **own re-entry guard** — a tick skips a row that is still running from the
previous tick, and only that row. This is stricter than today (`timers.ts` has no overlap guard
at all) and is the safe direction when the interval gets five times shorter.

Consequences the maintainer has already accepted:

- PULL polling becomes **punctual** rather than rounded up to the next 5 s boundary. A message
  scheduled 10 s out is polled at 10 s, not 10–15 s. Since each poll advances the ladder, a
  message fits marginally more polls into its life. If that makes the ladder too aggressive,
  that is a ladder question — now visible and tunable.
- A tick faster than `minIntervalMs` removes the hidden floor under `spacing` admission.
  LoRaWAN pacing comes from the `SET NX PX` lock on the ready queue, not from the tick, so
  `minIntervalMs` finally means what it says.

A fixed tick is a deliberate simplification. The exact design sleeps until the earliest due
score, which requires recomputation on every insert. The tick carries a comment naming the
ceiling (±1 s punctuality) and that upgrade path.

### 11. One TTL knob (A5)

`delivery.messageTtlSeconds` becomes the single source of truth: it sets the message-hash TTL at
enqueue (deleting the `MESSAGE_TTL_SECONDS` constant) and it remains the index TTL at stage
moves. The TypeScript parameter threaded through the moves is renamed `indexTtlSeconds`, which
is what it has always been at the Lua boundary (`index_ttl_seconds`). Same numbers today; the
knob stops being inert and the parameter stops lying.

### 12. The current stage stays derivable; no new hash field

Under Option A, `(deliveryStatus, deliveryPattern)` identifies the stage without ambiguity —
`DELIVERED_TO_NS` means `relayNode` on PUSH and `awaitingTask` on PULL, and every other status
maps to exactly one stage. Nothing new is written to the message hash, which is what keeps
decision 1 true. Cancel's existing status → queue-key branch becomes a lookup in that same map.

Option B breaks this property, and § *Upgrade path* says how.

### 13. Enqueue's distribute kick is gated on the engine, not on a test flag

`kickDistributeOnEnqueue` (B3) is a production option that exists only so the cancel smoke can
keep a message `QUEUED`. Once the engine has an explicit tick a test can call, the flag can be
replaced by the honest condition: enqueue kicks distribution **when the engine is enabled**.
Production latency is unchanged; a test that wants a message to stay queued constructs the
service with `engine.enabled` false and drives the tick itself.

---

## Invariants

These hold Option A in a shape where the upgrade below stays a patch rather than a rewrite. They
are the load-bearing part of this ADR for anyone implementing or reviewing it.

- **No hand-written stage lists anywhere.** Cleanup, metrics, and the tick derive their keys from
  the table. A literal array of queue names in a second file is precisely how A4 and the metrics
  list drifted apart.
- **Pipelines are data, not control flow.** `PIPELINES[pattern]`, never `if (pattern === 'PULL')`.
  A lookup becomes overridable by adding one `??`; a branch does not.
- **Exactly one `advance(message, plugin)`.** If two call sites decide what comes next, one of
  them will be forgotten — that is the shape of A3.
- **Stage actions never name a plugin.** An action reads the stage definition and the message.
  The moment an action tests `pluginId`, the pipeline has become per-plugin in fact but not in
  type, and the cheap upgrade path is gone.

## Shape in code

Indicative, not binding on names: a `stages` module (the table, the pipelines, `advance`, key
enumeration), a `runner` module (scan due members, apply outcomes), and an `actions` module (the
five `onDue` implementations).

The table itself holds **no behaviour and no Redis import** — actions are injected at the
composition root. That is what lets the rows be unit-tested as data, and it keeps the one module
every other part of the engine reads from being another global connection (B2, C1).
**Deleted in C2:** `lib/lifecycle.push.ts`, `lib/lifecycle.pull.ts`,
`lib/queue-moving.push.ts`, `lib/queue-moving.pull.ts`, `PUSH_QUEUE_KEYS`,
`PUSH_TIMEOUT_REASONS`, and `lib/queue-moving.ts`. The table lives in
`src/engine/lifecycle/` (`stages.ts`, `moves.ts`, `actions.ts`, `runner.ts`).

---

## Consequences

### Positive

- *"What happens when delivery fails at the relay-node stage?"* is answered by reading one table
  row instead of five files and two services.
- A1, A2, A3 and A4 are closed structurally: the type system and one runner enforce what were
  four per-stage conventions.
- Three enumeration sites (cleanup, metrics, the tick) share one source, so they cannot drift.
- One interval instead of three, and one number instead of three.
- A per-tick full ZRANGE of every PULL awaiting-task queue disappears (decision 9).
- Adding a stage becomes adding a row. Adding a *plugin* needs no lifecycle knowledge at all.

### Negative / Risks

- A large single-slice refactor of the engine's core loop. Mitigated by decision 1 (the data is
  untouched, so a revert is a code revert) and by the integration suite grown in **B1b**, which
  pins A1–A4 as today's wrong-but-real behaviour so the diff has to flip those assertions
  deliberately.
- The in-memory in-flight set (decision 8) is process-local state, which is another dependency on
  ADR-007's single-writer assumption. Named there rather than hidden, with its multi-replica form
  worked out under *Triggers* so it is a known move rather than a surprise. It also brings a
  dependency of its own: plugin clients must carry a 120 s safety deadline so the promise always
  settles.
- One tick means one place where a pathological stage can consume the loop. Per-row concurrency
  and per-row re-entry guards bound it; the `LIMIT 50` scan batch caps the work per row.
- Timing changes for PULL polling (decision 10) and for the 48-hour cap (decision 9) are real,
  though both are far inside existing tolerances.

## Rejected

- **Point fixes for A1–A5 instead of the table.** About a dozen hand-written guards, in the same
  shape that produced the bugs, that the table would then delete. Explicitly reconsidered if the
  design proved sprawling — it did not.
- **Changing the Redis layout to make the table prettier** (for example one stage key with a
  compound member, or the retry wait as a future score on the ready queue). Costs a migration,
  costs operator familiarity, and buys nothing the table does not already give. See decision 2
  for why the retry queue in particular cannot merge.
- **A client fetch deadline set *at* the stage deadline, so a send cannot outlive it.** Attractive
  until you follow it through: aborting at 20 s after the vendor has accepted the command means
  never learning the task id, then retrying — the same duplicate command as A3, arrived at more
  deliberately. Decision 8 extends the wait instead of severing it, and pairs that with a 120 s
  client deadline whose only job is to guarantee the promise settles. `docs/decisions-log.md`
  § *Parked / revisit* reached the same conclusion independently: a *generous safety* deadline,
  explicitly **not** abort-at-NS-timeout.
- **Building per-plugin pipelines now.** No plugin needs them. See the trigger below.
- **A `stage` field on the message hash.** Unnecessary under Option A (decision 12) and it would
  break decision 1. Option B adds it when Option B is built.

## Upgrade path — per-plugin stage pipelines ("Option B")

> **Designed, deliberately deferred.** Do not build speculatively. When the trigger fires,
> implement what is written here; it does not need to be re-derived. The stage table in code
> carries a one-line comment pointing at this section.

**Build B when, and only when, all three hold:**

1. A new plugin needs a **different number or kind of waits** than its `deliveryPattern`'s
   pipeline provides — not different *timeouts* (that is `PluginTuning`, already per-plugin) and
   not a different *transport* (that is the SPI, already per-plugin), but a genuinely different
   *sequence of things the engine waits on*.
2. The extra wait needs its **own queue** — its own deadline, its own action, its own depth
   metric. If it can be expressed as "the same stage with a longer timeout", it is not a stage.
3. Squeezing it into an existing pipeline would put an `if (pluginId === …)` inside a stage
   action. That branch is the smell saying the pipeline should be data.

If only (1) holds, prefer a third fixed *delivery* pipeline in the pattern table — cheaper, and
honest, because the pipeline is then a property of a *pattern*, not of a *vendor*. (`'NONE'` is
never a candidate: token-only plugins have no pipeline.)

**Known candidate.** SparkMeter: HTTP/API-shaped, so `PULL`-ish, but one `sparknet-http`
instance per gateway with a radio mesh behind it. The vendor API accepting a command says
nothing about the mesh having carried it — a second, independent wait with its own failure mode.

**The design.** A plugin may contribute stages and declare its own pipeline:

```ts
type StageDefinition = {
  /** Redis key suffix; namespaced per plugin by the engine. */
  readonly name: string;
  /** How this stage stops waiting. Decides which runner drives it. */
  readonly advancedBy: 'ingress' | 'poll' | 'timeout';
  /** Deadline (ingress/timeout) or next-poll delay (poll), in ms. */
  readonly waitMs: (message: DeviceMessage) => number;
  /** What running out of wait means. */
  readonly onExpiry: 'fail' | 'retry';
};

type DeliveryPlugin = {
  // …existing PUSH | PULL SPI…
  /** Stages this plugin adds beyond the core set. Optional. */
  readonly stages?: readonly StageDefinition[];
  /** Ordered stages a message traverses. Defaults to PIPELINES[deliveryPattern]. */
  readonly pipeline?: readonly string[];
};
```

`advancedBy` is the real conceptual addition, and the reason B buys flexibility rather than
indirection: it lets one plugin mix a *polled* wait and an *ingress* wait in a single pipeline,
which is exactly what an API-front / radio-behind integration needs and what neither fixed
pipeline can express.

**Four concrete changes:**

1. **A `stage` field on the message hash.** Arbitrary stages reuse delivery statuses, so the
   stage stops being derivable (decision 12). Additive and backfillable: for messages in flight
   at deploy time, derive `stage` from the same `(deliveryStatus, deliveryPattern)` rule.
2. **Stage keys become plugin-namespaced** — `queue_stage:{pluginId}:{stageName}`. The
   convention already exists (`queue_awaiting_task:{pluginId}` is exactly this shape), so
   `awaitingTask` stops being special and becomes an ordinary stage the CALIN plugins share.
   Core stages keep their current unnamespaced keys.
3. **The three enumeration sites read the registry instead of the table constant** — "core
   stages + contributed stages of every enabled plugin". Mechanical, *provided* the invariants
   above held.
4. **`advance` consults the plugin**: `plugin.pipeline ?? PIPELINES[plugin.deliveryPattern]`,
   then `pipeline[indexOf(current) + 1]`. One function, one call site.

Not changed: admission, the ready queue, the retry ladder, the webhook layer, the SPI's
transport methods. B is confined to the stage table.

**Worked example — SparkMeter under B:**

```ts
export const sparkMeterPlugin = {
  id: 'sparkmeter',
  deliveryPattern: 'PULL',
  stages: [
    { name: 'gatewayAccepted', advancedBy: 'poll',    waitMs: pollLadder,    onExpiry: 'retry' },
    { name: 'meshDelivered',   advancedBy: 'ingress', waitMs: () => 300_000, onExpiry: 'retry' },
  ],
  pipeline: ['ns', 'gatewayAccepted', 'meshDelivered'],
  // …transport methods…
};
```

Send to the gateway's `sparknet-http` (`ns`); poll the gateway until it confirms it took the
command (`gatewayAccepted`); then wait up to five minutes for the mesh to report the meter
actually received it (`meshDelivered`). Three waits, two mechanisms, one plugin — and core needs
no knowledge of SparkMeter to run it.

**Relationship to capability bundles.** Option B and the capability-bundle refactor
(`docs/plans/002-architecture-review.md` § C3) are two axes of one idea: a plugin declaring
which capabilities and which policy it has. Neither needs the other, but building them apart
means two SPI reshapes instead of one.

## Triggers (revisit when)

- Option B's three conditions all hold (see above).
- Multi-replica is reopened (ADR-007). The runner's single-writer assumption needs a leader or a
  partition at that point; decision 8's in-flight set needs the smaller change described below.
- The fixed 1000 ms tick shows up as measurable idle cost, or punctuality tighter than ±1 s is
  needed — then implement sleep-until-earliest-due.

### The in-flight set under multi-replica: move the write, not the state

Decision 8's set is process-local, which normally rules a mechanism out of a multi-replica
future. Here it does not, because what the set encodes — *"some process is actively awaiting this
send"* — is a lease, and the NS stage score is already a lease with an expiry. The upgrade is to
move where that lease is written, not to introduce a new key:

| | Single replica (built) | Multi-replica (upgrade) |
|---|---|---|
| Who writes | The **scanner**, when the score comes due | The **owner**, on every tick while awaiting |
| What it writes | Extend the score after consulting its own set | Extend the score as a heartbeat |
| What a scanner does | Consult the set, then decide | Trust the score; a future score means owned |

Under the built version a *second* replica scanning the NS queue would not find the id in *its*
set and would wrongly fail a perfectly healthy send — so do not run two replicas expecting this
to hold. Under the upgrade, the score carries the fact, so any scanner behaves correctly, and a
dead owner stops heartbeating, lets the score lapse, and hands the message to whoever reclaims
it. Same set, same tick, same key; the extend moves from the due-check to the sender.

This is the cheapest of the three single-writer dependencies to lift. The other two — the
ChirpStack correlator's in-memory `Map` and the absence of leader election over the tick — are
the ones that actually gate multi-replica (ADR-007).

## Related

- **ADR-006** — admission and the ready queue: the half of the lifecycle this table excludes.
- **ADR-007** — single writer; decision 8 and the runner both depend on it.
- **ADR-003** — the outbound webhook that terminal stages emit before cleanup.
- **`nxt-backend` ADR-001** — why PUSH and PULL diverge at all.
- **`docs/plans/002-architecture-review.md`** — findings A1–A5, B3, C1, C2 and their evidence.
