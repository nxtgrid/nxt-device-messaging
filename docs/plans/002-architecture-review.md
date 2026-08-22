# Plan 002 — Architecture review and deepening

**Status:** open. Review complete (2026-08-18/19). Branch 1 (B1, C2 design, B1b, C3) merged.
Branch 2: **ADR-008, C2, and C1 landed.** Branch 3: **C4 landed.** Next is D (docs compact),
then optionals.
**Branch:** branch 3, cut after branch 2. See § *Branch discipline*.
**Supersedes nothing.** `docs/plans/001-extraction.md` is finished work and stays as history.

This plan is the executable follow-up to a deep architectural review of the service as it stands
after the extraction closed. Its aim is **not** feature work. It is to make the codebase easier for
a human to reason about, with testability and AI navigability as secondary targets, and to close
the correctness gaps the review found around message loss, stuck messages, and Redis growth.

---

## How to pick this up cold

1. Read this file top to bottom. It is self-contained — you do **not** need the chat it came from.
2. Read `docs/decisions-log.md` § **Parked / revisit** for work that is deliberately *not* here.
3. Do **one** item. Stop. Wait for the maintainer to review and commit.

Every finding below carries its own evidence (file and line at time of review), so you can verify
the claim before acting on it. If the evidence no longer matches the code, say so and stop — do not
guess at what was meant.

### Rules of engagement

- **Check the Checklist's `Model` column before starting an item, and switch or delegate to that
  model.** The column is a cost decision, not a suggestion. If you are a more expensive model than
  the item calls for, say so and delegate before doing the work — not after.
- **The maintainer reviews and commits. Always.** Never commit, amend, or push.
- **Discuss before coding.** Each item gets a shared understanding first, then an implementation.
  For items marked *design settled* below, the discussion already happened — the design is recorded
  here and you may implement it directly.
- **One item per turn.** Mark it in progress, do it, summarise, stop.
- **No unsanctioned exploration.** Stay on repo files and short, task-specific commands.
- Update the **Checklist** and the **Session notes** section when an item lands.

---

## Checklist

Ordered. Later items may depend on earlier ones — the dependency is called out where it exists.

| # | Item | Depends on | Model | Branch | Status |
|---|---|---|---|---|---|
| 1 | **B1** — Valkey service container in CI; run the integration smokes | — | Composer 2.5 | 1 | ☑ 2026-08-19 |
| 2 | **C2 design** — message-lifecycle stage table (discussion, no code) | 1 | Claude Opus 5 | 1 | ☑ 2026-08-20 |
| 2b | **B1b** — thicken the engine integration suite *against current behaviour* | 1 | Grok 4.6 | 1 | ☑ 2026-08-20 |
| 2c | **C3** — plugin SPI as a discriminated union on `deliveryPattern` | — | Grok 4.6 | 1 | ☑ 2026-08-20 |
| 3 | **ADR-008** — message lifecycle stage table (first commit on branch 2) | 2 | Claude Opus 5 | 2 | ☑ 2026-08-20 |
| 4 | **C2** — implement the stage table | 2b, 3 | Claude Opus 5 | 2 | ☑ 2026-08-21 |
| 5 | **A1 + A2** — orphan scrubbing and poll-score advancement | 4 | — | 2 | ☑ 2026-08-21 folded into 4 |
| 6 | **A3** — NS-stage timeout vs. in-flight send | 4 | — | 2 | ☑ 2026-08-21 folded into 4 |
| 7 | **A4 + A5** — cleanup completeness; single source of truth for the TTL | 4 | — | 2 | ☑ 2026-08-21 folded into 4 |
| 8 | **C1** — inject the message store instead of importing a global | 4 | Claude Opus 5 | 2 | ☑ 2026-08-22 |
| 9 | **C4** — core-owned default `PluginTuning` | 2c | Grok 4.6 | 3 | ☑ 2026-08-22 |
| 10 | **D** — compact the docs; strip extraction markers from `src/` | — | Composer 2.5 | 3 | ☐ |
| 11 | **Optional** — drop `ramda`; share the three identical CALIN helpers; spacing-floor note; check-then-claim race | — | Composer / Grok | 3 | ☐ |
| 12 | **Capability bundles** — token providers vs delivery plugins (designed, not built) | — | — | 3 | ☐ trigger-gated |

### Branch discipline

Branches in sequence. Nothing in this plan lands directly on `main`.

**Branch 1 — `chore/post-extraction-refactor`** (merged as PR #12).
Items 1 (B1), 2 (C2 design), 2b (B1b), and 2c (C3) are on this branch. Scope was **the
prerequisites for C2 and nothing else**. Keeping the scope that tight is deliberate: it is what
makes the review tractable and lets branch 2 start from a known-good base.

Nothing else qualifies as a prerequisite. **B2** resolves as a consequence of C1 and so belongs to
branch 2; **B3**'s single real offender (`kickDistributeOnEnqueue`) disappears inside C2 rather than
needing a prior fix; **A1–A5** are folded into C2 by design. **C4 was not pulled onto branch 1.**

**Branch 2 — `refactor/message-lifecycle-stage-table`**, cut from `main` after branch 1 merged.
The big slice as one reviewable, revertible unit: item 3 (ADR-008) as its first commit, then 4,
with 5–8 folded in. **C2 and C1 landed.**

**Branch 3 — anything after that.** Items 9, 10, 11 and 12 are independent of C2 in both
directions. **9 (C4) landed** on this branch. 10–12 remain.

### Why this order

A1–A5 are all symptoms of the same missing structure (see **C2**). Fixing them as local patches
adds roughly a dozen hand-written guards that C2 would then delete and rewrite. Settling C2's shape
first turns four bug fixes into one place where the rule is stated once. None of A1–A4 is currently
burning production (see each item's *Reachability*), which is what buys us the right to do this in
the structurally cheaper order.

If the C2 design turns out sprawling or risky, **abandon it and write the point fixes instead** —
the cost of trying is one conversation, not a week.

---

## A. Correctness — loss, stuck, balloon

The maintainer's primary concern: *messages must not get lost, get stuck, or balloon the Redis DB.*

### A1 — `queue_awaiting_task` is the only queue that cannot self-heal

**Symptom.** A message ID whose hash no longer exists stays in `queue_awaiting_task:{pluginId}`
forever, with a score in the past. Because the poll scan is `ZRANGEBYSCORE … LIMIT 0 50`, fifty such
orphans permanently starve live messages out of every poll batch. Both a leak and a stall.

**Evidence.**

- `src/lib/lifecycle.pull.ts:79` — `if (!message?.deliveryQueueId) continue;` skips without ZREM.
- `src/lib/lifecycle.pull.ts:128` — `if (!message) continue;` in the 48h reaper, same omission.
- Contrast — sites that *do* scrub: `src/engine/base.ts:87-90` (`retryOrFail`),
  `src/engine/base.ts:155-158` (`requeueMessage`), and both Lua scripts
  (`fetch-next-message-in-queue.lua:63-65`, `move-message-between-queues.lua:58-60`).

**Root cause.** "Read a hash for an ID taken from a sorted set" appears in five places. Three scrub
the orphan, two do not. The rule has no single home.

**Reachability.** Requires a hash to vanish while its ZSET member survives: Redis eviction under
`maxmemory` pressure, or the engine being disabled for longer than the 7-day hash TTL (the 48h PULL
reaper would otherwise clear it first). Latent, not a daily occurrence.

**Direction.** One self-scrubbing read at the choke point, used by all five scan sites — not five
guards. Exact shape depends on **C2**.

**Done when.** No scan loop can leave an orphan behind, and an integration test fails if one does.

### A2 — the poll score only advances on one branch

**Symptom.** A message whose `fetchStatus` returns an event that `_processIncomingEvent` does not
resolve terminally keeps its old (past) score, so it is re-polled against the vendor API every 5
seconds until the 48-hour cap. Vendor hammering plus head-of-line blocking.

**Evidence.**

- `src/lib/lifecycle.pull.ts:83-90` — the score is only updated in the `if (!parsedEvent)` branch.
- Non-terminal early returns in `src/engine/incoming.ts`: line 92 (no `deliveryQueueId`), line 98
  (no message for `deliveryQueueId`), line 119 (unexpected `deliveryStatus`), line 125 (message
  already cleaned up).

**Root cause.** Same as A1: score advancement is a side effect of one code path rather than a
property of the loop.

**Reachability.** Any vendor response the plugin parses but the engine does not recognise. Self-
limits at the 48h reaper.

**Direction.** Advance the score unconditionally on every poll attempt; terminal paths remove the
member anyway. Fold into **C2**.

**Done when.** A polled message's next-poll score always moves forward, whatever the outcome.

### A3 — post-send queue moves ignore their return value → duplicate commands to hardware

**Symptom.** When `sendOne` outlives `nsInFlightTimeoutMs`, the resolution cycle has already moved
the message to the retry queue. The subsequent stage move then fails, and the failure is discarded.
Result: the vendor **has accepted** the command, no `idx:external_delivery_id` index exists so the
response can never be routed, and the message is sent again. For `TOP_UP_KWH` / `TURN_OFF` that is a
duplicate physical action on a meter.

**Evidence.**

- `src/engine/outgoing.ts:223-239` — neither `moveQueuePull.fromNsToAwaitingTask` nor
  `moveQueuePush.fromNsToRelayNode` has its `boolean` result checked.
- `src/lib/queue-moving.ts:58-85` — `_moveQueue` returns `false` when the ZREM gate misses.
- `src/engine/outgoing.ts:200-209` — the code already logs
  `'sendOne slow; resolution cycle may have already scheduled a retry'`, then drops the one value
  that would confirm it.
- Default `nsInFlightTimeoutMs` is `20_000` (all plugins); `calin-api-v1`'s client sets no fetch
  deadline.

**Reachability. Confirmed in production.** The maintainer has observed CALIN API calls taking up to
**37 seconds** — nearly twice the NS timeout. Rare, but real, and silent every time.

**Direction.** Two layers, to be settled in the item-4 discussion:

1. *Minimum* — check the boolean; log and count the orphaned send (new metric).
2. *Real* — decide what the NS-stage timeout should mean while the plugin still holds the
   connection. This is a lifecycle question, hence the dependency on **C2**.

**Done when.** A send that lands after its NS-stage timeout cannot produce a second delivery
attempt without an explicit, counted decision to do so.

### A4 — `messageFullCleanup` is not full

**Symptom.** The function named "full cleanup" leaves references behind. It works only because of
compensating behaviour in files that do not mention it.

**Evidence.** `src/lib/redis-repository/index.ts:413-449` ZREMs three fixed stage keys plus
`queue_awaiting_task:{pluginId}`, and SREMs the concurrency key. It does **not** touch
`queue_awaiting_retry`, the plugin's initial queue, or `queues_to_distribute_from`. Compensation:
`requeueMessage` scrubs orphaned retry IDs (`base.ts:155-158`); the distributor Lua GCs empty initial
queues (`fetch-next-message-in-queue.lua:42-55`); cancel handles the retry queue explicitly
(`outgoing.ts:359-372`).

**Prior art.** This is parked item **D2** in `docs/decisions-log.md`, and the carried finding
"Thorough message-cleanup tests".

**Direction.** Either make it genuinely complete, or rename it to what it does. Prefer the former,
with an integration test asserting that every exit path (success, final failure, PULL age timeout,
cancel) leaves zero references.

**Done when.** An enqueue-to-exit integration test asserts an empty Redis keyspace for every exit
path, for both PUSH and PULL.

### A5 — two sources of truth for the message TTL

**Symptom.** `config.delivery.messageTtlSeconds` does not govern the message hash TTL, despite its
name. The config value is threaded through every stage move and used there as the *index* TTL.

**Evidence.**

- `src/lib/redis-repository/index.ts:30` — `MESSAGE_TTL_SECONDS = 7 * 24 * 60 * 60`, used at
  `enqueueDeviceMessage` (line 198).
- `src/config/schema.ts:9` — `messageTtlSeconds: z.number().int().positive().default(604800)`.
- `src/lib/queue-moving.ts:67, 81` — the parameter named `messageTtlSeconds` is passed to the Lua as
  `index_ttl_seconds` (`move-message-between-queues.lua:44, 80`).

Same number today, so no live bug — but the knob is inert and the parameter is misnamed at every
call site.

**Direction.** One source of truth. Either drop the constant and thread config through to enqueue,
or drop the config knob. Rename the stage-move parameter to `indexTtlSeconds` regardless.

**Done when.** Changing `delivery.messageTtlSeconds` in config demonstrably changes the hash TTL, or
the knob is gone.

---

## B. Testing and CI

### B1 — the delivery engine is not tested in CI

**Symptom.** Everything in section A is untested by CI. 284 unit tests pass in ~3.7s and none of them
touch the delivery loop.

**Evidence.** `.github/workflows/build.yml` (note: **`build.yml`**, not `ci.yml`) ran `pnpm lint`,
`pnpm test`, `pnpm build`. All eight engine integration smokes under `test/integration/` are gated
behind `describe.skipIf(process.env.RUN_REDIS_SMOKE !== '1')`, and nothing in CI set it.

**Direction.** Add a Valkey service container to the `build` job and a step running
`pnpm test:integration` (already defined in `package.json`, sets `RUN_REDIS_SMOKE=1` and
`--fileParallelism=false`). Point `REDIS_HOST`/`REDIS_PORT` at the service.

**Done when.** A pull request that breaks distribute, the resolution cycle, PULL polling, cancel, or
the webhook drain fails CI.

**✅ Landed 2026-08-19.** `valkey/valkey:8-alpine` service container with a `valkey-cli ping` health
check, plus a `pnpm test:integration` step between `pnpm test` and `pnpm build`, with `REDIS_HOST` /
`REDIS_PORT` / `REDIS_DB` set explicitly. Verified locally: 8 files, 9 tests, all passing in ~5.7s.

### B1b — the integration suite is thin (new, discovered while landing B1)

**Symptom.** CI now *runs* the engine tests, but there are only **9 tests across 8 files** — roughly
one happy path per surface. There is no coverage of failure paths, orphan scrubbing, cleanup
completeness, or the timeout/retry ladder. B1 gave us a harness, not yet a safety net.

**Why it matters here.** Items 3–6 (and especially the **C2** restructure) are only safe to attempt
against tests that would actually notice a regression. A green build on 9 happy-path tests would not.

**Overlap.** This is the same work as parked item **D2** / the carried finding "Thorough
message-cleanup tests" in `docs/decisions-log.md`.

**Direction.** Before **C2** is implemented (the design in item 2 can proceed regardless), grow the
suite to cover, for both PUSH and PULL: send failure → retry → requeue → eventual permanent failure;
every exit path leaving zero Redis references (**A4**); an orphaned ZSET member being scrubbed
(**A1**); a polled message always having its score advanced (**A2**).

**Sequencing note.** Write these tests **against current behaviour first**, so they pass before the
restructure and must still pass after it. That is what makes C2 verifiable rather than hopeful.

**Model.** Grok 4.6.

**✅ Landed 2026-08-20.** Four helpers (`test/helpers/programmable-plugin.ts`,
`redis-references.ts`, `webhook-recorder.ts`, `wait-for.ts`) and four spec files
(`outgoing-retry-ladder.smoke.spec.ts`, `outgoing-timeouts.smoke.spec.ts`,
`lifecycle-orphans-and-cleanup.smoke.spec.ts`, `incoming-poll-outcomes.smoke.spec.ts`).
`test/integration/incoming-poll.smoke.spec.ts` was left untouched; the new PULL coverage
went into the sibling `incoming-poll-outcomes.smoke.spec.ts` to avoid churning the existing
file. Verified locally: 12 files, 31 tests (was 8 files, 9 tests). A1/A2/A3/A4 gaps are
asserted as today's wrong-but-real outcome with comment markers, so C2's diff flips them.

### B2 — `pnpm test` opens six real Redis connections

**Symptom.** Importing any engine module dials Valkey as an import side effect. Verified: six
`connected module: "redis"` log lines during `pnpm test`. Passes locally only because Valkey is up;
in CI without a Valkey service it becomes a background reconnect storm.

**Evidence.** `src/lib/redis-repository/index.ts:144` — `const _client = new Redis(...)` at module
scope, with `defineCommand` and an event handler wired immediately after.

**Direction.** Resolved as a consequence of **C1**. If it becomes annoying before then, a lazy
connect (`lazyConnect: true`) is a standalone one-liner.

### B3 — test-support code in the production path

Only one real offender: `kickDistributeOnEnqueue` (`src/engine/outgoing.ts:87-92`) is a production
option that exists solely so the cancel smoke can keep a message `QUEUED`.

Not offenders, leave alone: injectable `occurredAt`/`eventId` in
`src/engine/webhook/build-event.ts:20-26`, interval overrides in `src/engine/timers.ts:24-27`, and
`defaultConfigPath` in `src/config/load.ts` — those are normal seams.

**Direction.** Fold into **C2**: if distribution is driven by an explicit tick the test can call,
the flag disappears rather than moving.

---

## C. Deepening — shallow modules worth making deep

*"Deep" in the Ousterhout sense: a simple interface hiding substantial functionality. A shallow
module's interface costs about as much to understand as its implementation.*

### C1 — `redisRepo` is a 20-method pass-through, and it is a global

**Symptom.** Every method is a one-line Redis call, so the engine speaks Redis rather than delivery.
`src/engine/outgoing.ts` alone has to know that ZREM is an ownership claim, that a sorted-set score
means a timeout in one queue and a next-poll-time in another, which key each stage lives under, and
that `queues_to_distribute_from` exists at all.

**Evidence.** `src/lib/redis-repository/index.ts` — 522 lines, ~20 methods, most of them a single
`_client.*` call. Module-level singleton, imported directly by `engine/base.ts`,
`engine/outgoing.ts`, `engine/incoming.ts`, `lib/queue-moving*.ts`, `lib/lifecycle.*.ts`.

**Tension with stated conventions.** ADR-001 §2 and `AGENTS.md` prefer factory + closure DI.
Everything else follows it — `createBaseService`, `createOutgoingService`, and notably
`createWebhookStore`, which *does* take an injected client. The one module that matters most does
not.

**Direction — and an explicit caution.** Do **not** treat this as its own project. Injecting the
current 20-method surface removes the global and fixes B2, but leaves a dependency-injected shallow
module — barely an improvement in reasoning terms. The depth win only appears once **C2** has
collapsed what the engine needs to ask Redis for. C1 is an *outcome* of C2.

#### Concrete shape (written 2026-08-21 at the end of C2.4, while the context was warm)

**Step 1 is deletion, not injection.** Four methods are dead now that the stage table replaced the
poll scan: `getMessageRawPropsById`, `getAllMessageIdsInQueue`, `getMessagesDueForPolling`,
`updateNextPollTime`. Nothing in `src/` or `test/` calls them. That is 20 methods → 16 before any
design work, and it is the cheapest review of the session.

**Step 2 is one client, created not imported.** `src/lib/redis-repository/index.ts` builds its
client at module load and registers the Lua scripts there; that module singleton *is* the global.
Extract `createRedisClient(options)` (client + `defineCommand` registration), call it once in
`main.ts`, and keep `redisRepo` as a thin adapter over the injected client so nothing else moves
yet. `main.ts` already wants the raw client three times (metrics, `createWebhookStore`, `quit`), so
it becomes a local rather than a property of a global.

**Step 3 is three ports, not one.** A single injected `Store` would be the same shallow surface
with a parameter — the failure the caution above warns about. The engine's remaining Redis calls
cluster cleanly, so split along the clusters:

| Port | Methods | Who imports it |
|---|---|---|
| `MessageStore` | `enqueueDeviceMessage`, `getMessageById`, `getMessageFromCorrelationId`, `getAllMessagesForCorrelationId`, `getMessageIdFromDeliveryQueueId` | `outgoing` (enqueue / get / cancel), `incoming` (ingress lookup), `base`, `runner` |
| `StageStore` | `moveMessageBetweenQueues` + `fetchNextMessageInQueueAndMove` (Lua), `getExpiredMessagesInQueue`, `removeMessageFromQueue`, `requeueMessage`, `messageFullCleanup`, `fetchQueuesWithMessages`, and the raw `zadd` / `zscore` / `hmget` / `multi` that `enterRetry` needs | `lifecycle/moves.ts` and `lifecycle/runner.ts` — **nothing else** |
| `AdmissionStore` | `lockQueueForTimeMs`, `claimConcurrencyRateLimit`, `getConcurrencyRateLimitCount`, `validateAndCleanConcurrencyRateLimit` | `outgoing` (`_canAdmit` / `_onClaimAfterPick`) |

The payoff is in the third column. `StageStore` is the one that carries real Redis vocabulary, and
after C2 only two files touch it — `moves.ts` already hides it behind `StageMoves`. So once this
lands, the engine's Redis knowledge is: `outgoing` knows admission and message CRUD, `incoming` and
`base` know how to load a message, and nothing else speaks Redis at all. That is the depth win the
caution was holding out for, and it is only available because C2 removed the callers first.

Factories mirror `createWebhookStore`, which already takes an injected client:

```ts
export function createMessageStore(deps: { readonly client: Redis }): MessageStore;
export function createStageStore(deps: { readonly client: Redis }): StageStore;
export function createAdmissionStore(deps: { readonly client: Redis }): AdmissionStore;
```

**Suggested order**, cheapest proof first: delete the four dead methods → extract
`createRedisClient` → `AdmissionStore` (4 methods, one consumer, proves the shape) → `MessageStore`
→ `StageStore` last, because it is the largest but has only two consumers and a spec suite that
already drives it end to end.

**Two questions to settle when C1 starts.** Does `messageFullCleanup` belong to `StageStore` or
`MessageStore`? It deletes the hash and indexes but ZREMs queues. Recommendation: `StageStore`,
because its only caller is `moves.purge` and grouping by *caller* is what makes the third column
above narrow. And `base.retryOrFail` currently ZREMs an orphan itself (`base.ts:97`) although the
runner scrubs orphans too — check whether that call can simply go, which would drop `base`'s
`StageStore` need entirely.

**Out of scope.** C1 is about narrowing what the engine may ask, not about portability. Do not add
an abstraction layer for swapping Redis out; the ports are typed against the real client.

### C2 — the message lifecycle exists nowhere as a single readable thing

**Symptom.** To answer *"what happens when delivery fails at the relay-node stage?"* you must read
five files plus two engine services. The PUSH/PULL split is a file-layout split, but the two patterns
differ in only a few properties: which queue, what the score means, and who reports the outcome.
Everything else is common and currently duplicated in branches and prose.

**Evidence.** The lifecycle is spread across `src/engine/outgoing.ts` (the five hand-written steps of
`runMessageResolutionCycle`, lines 250-298), `src/engine/incoming.ts` (`_processIncomingEvent`),
`src/lib/queue-moving.ts`, `src/lib/queue-moving.push.ts`, `src/lib/queue-moving.pull.ts`,
`src/lib/lifecycle.push.ts`, and `src/lib/lifecycle.pull.ts`.

**Why it is the root of A1–A4.** Each of those bugs is a rule that should hold for every stage but is
implemented by hand per stage, and forgotten somewhere:

| Bug | The rule that has no single home |
|---|---|
| A1 | "An ID whose hash is gone must be scrubbed from its queue" — present in 3 of 5 scan sites |
| A2 | "A poll attempt always advances the next-poll score" — present in 1 of 5 branches |
| A3 | "A stage transition can fail and the caller must handle that" — return value read in 0 sites |
| A4 | "Cleanup removes every reference" — true for 4 keys, false for 3 |

**Direction (to be designed in item 2).** One declarative stage table — stage → Redis key, delivery
status, timeout source, next-on-success, next-on-failure — with PUSH and PULL as rows rather than as
files. `runMessageResolutionCycle` becomes a loop over it. Candidate deletions:
`lib/lifecycle.push.ts`, `PUSH_QUEUE_KEYS`, `PUSH_TIMEOUT_REASONS`, and most of both
`queue-moving.*.ts` files.

**Constraint.** Do not start this without **B1** green and **B1b** landed on `main`.

#### Design settled → **`docs/architecture/008-message-lifecycle-stage-table.md`**

The design lives in **ADR-008**, which is the first commit on branch 2 and the normative source
for the C2 implementation. Do not relitigate it; do not re-derive it from this plan.

What it settles, in one line each: the Redis layout does not change (1); ready queue vs scheduled
stage (2); the five-row table, deadline ≡ next-poll time (3); pipelines as data, Option A (4);
`onDue` returns a discriminated outcome and the **runner** scrubs orphans and advances scores —
the structural fix for **A1** and **A2** (5); one `advance` owns the edges — **A3** layer one (6);
cleanup and metrics derive their key lists from the table — **A4** (7); the NS deadline does not
fire while this process still holds the send — **A3** layer two (8); the 48 h PULL cap becomes a
property of the `awaitingTask` stage (9); one 1000 ms tick, stages concurrent, members sequential,
per-stage re-entry guard (10); one TTL knob — **A5** (11); the stage stays derivable, no new hash
field (12); enqueue's distribute kick is gated on the engine, not a test flag — **B3** (13).

Decision 8 carries two riders the maintainer added on review: a **120 s client safety deadline**
so `sendOne` always settles (unparks that half of *Plugin HTTP hygiene*), and a **bounded drain**
over the in-flight set that C2 exposes and **Shutdown v2** wires.

ADR-008 also carries the **invariants** the implementation must hold, the *Rejected* alternatives,
Option B (per-plugin pipelines) as its deferred upgrade path with the trigger that fires it, and
— under *Triggers* — the multi-replica form of the in-flight set ("move the write, not the
state": the owner heartbeats the NS score instead of a scanner consulting a local set).

### C3 — the plugin SPI should be a discriminated union

**Symptom.** The SPI documents a rule the type system could enforce, then pays for it with runtime
guards.

**Evidence.**

- `src/plugins/plugin.interface.ts:86-89` — *"Convention (not enforced by the type system): PUSH
  plugins implement `incoming.handle` and usually `outgoing.getRemoteStatus`; PULL plugins implement
  `incoming.fetchStatus` (no `getRemoteStatus`)"*.
- The discriminant already exists: `deliveryPattern: 'PUSH' | 'PULL'` (line 96).
- Guards it forces: `src/engine/incoming.ts:168-169` (`const parse = …; if (!parse) return;`),
  `src/lib/lifecycle.pull.ts:69` (`if (!fetchStatus) return [];`).

**Direction.** Make `DeviceMessagingPlugin` a union on `deliveryPattern`: `PUSH` requires `handle`,
`PULL` requires `fetchStatus` and forbids `getRemoteStatus`. TypeScript enforces the documented
convention for free and the guards delete themselves.

**Done when.** A plugin that declares `PULL` without `fetchStatus` fails `pnpm typecheck`.

**Independent of C2.** Can be done any time after B1.

**Accepted trade-off — double surface for `token`.** `token` is both an optional facet of a delivery
plugin (`calin-api-v1`, `calin-api-v2`, `stub-push` all declare it) and the entire content of a
`'NONE'` plugin. The duplication is in the *declaration* only, not the resolution path — the token
service resolves `registry.get(id).token` identically either way. This was accepted knowingly to
keep C3 small. The deferred way off that double surface is § *Capability bundles* below. `'NONE'`
is a step toward that, not the destination.

**✅ Landed 2026-08-20.** `DeviceMessagingPlugin` is `PushPlugin | PullPlugin | TokenOnlyPlugin`
(`DeliveryPlugin` = the first two). Discriminant `'NONE'` for token-only; that member has `id`,
`supportedCommandTypes`, required `token`, and `outgoing.sendOne` + `parseError` only — no
`admission`, `tuning`, `initialQueueKey`, or `incoming`. Deleted the type-workaround guards in
`engine/incoming.ts` (`if (!handle) return`) and `lifecycle.pull.ts` (`if (!fetchStatus) return
[]`); kept `lifecycle.push.ts` `if (!getRemoteStatus) return false` because it is still optional on
PUSH. `getByDeliveryPattern<P>` narrows via `PluginByDeliveryPattern` (generic + type predicate;
no casts). Plugin factories restructured into whole PUSH/PULL literals: `stub/index.ts` split into
`buildStubPush` / `buildStubPull`, `test/helpers/programmable-plugin.ts` likewise. `nxt-sts` dropped
the unused delivery fields. Ingress gates on `deliveryPattern !== 'PUSH'` rather than missing
`handle`.

#### Capability bundles — separating token providers from delivery plugins (designed, not built)

> **Status: designed, deliberately deferred.** Do not build this speculatively. When the trigger
> below fires, implement what is written here — the design is settled and does not need to be
> re-derived. `'NONE'` is *not* the destination; it is a step toward this. The PUSH/PULL union
> survives the bundle refactor intact; only the third member is absorbed.

**Trigger — build this when, and only when, either holds:**

1. A **second token-only provider** appears. One token-only plugin is not a pattern.
2. A plugin wants **`token` plus ingress but no delivery** — a shape `'NONE'` cannot express
   without growing a fourth member.

Do not build this because the double surface feels inelegant. That was accepted in C3.

**The design.**

A module returns a capability bundle instead of one fat object:

```ts
type CapabilityBundle = {
  readonly id: PluginId;
  readonly delivery?: DeliveryPlugin;  // the PUSH | PULL union
  readonly token?: TokenProvider;
};
```

so `calin-api-v1` returns `{ id, delivery, token }`, `calin-chirpstack` returns `{ id, delivery }`,
`nxt-sts` returns `{ id, token }`. The registry offers two lookups instead of one, and
`getByDeliveryPattern` becomes structurally incapable of returning a token-only provider.

**Why it works rather than duplicating effort.** v1/v2's mint and delivery calls share one login
and one set of credentials. Under a bundle they close over a single client inside the module
factory — the factory-plus-closure DI the repo already prefers. Two declared capabilities, one
construction, one set of secrets.

**What it buys.** The double surface disappears; exactly one way to declare "I can mint".

**What changes, concretely:**

1. **Catalog factories return a bundle**, not a `DeviceMessagingPlugin`. The SPI's PUSH/PULL
   members stay; `TokenOnlyPlugin` / `'NONE'` go away, absorbed into `token?: TokenProvider`.
2. **The registry splits.** `get(id)` can stay as a convenience for "anything with this id", but
   delivery and token become two lookups (`getDelivery(id)`, `getToken(id)`).
   `getByDeliveryPattern` only sees bundles that declared `delivery`.
3. **Engine call sites read the facet they need.** Enqueue / distribute / ingress / poll take a
   `DeliveryPlugin`. The token service takes a `TokenProvider`. No `deliveryPattern === 'NONE'`
   branches.

Not changed: the HTTP contract, adopter config (`plugins[].id`), or the plugin-id namespace.
`POST /token/generate` with `pluginId` and enqueue with the same id keep working untouched. This
is a purely internal refactor.

**Why deferring is safe.** The plugin id stays a single namespace, so callers cannot tell the
difference. `'NONE'` already stopped token-only plugins from growing fake delivery fields; the
bundle refactor only has to absorb one member, not unwind a lie.

**Relationship to C2 Option B** (ADR-008 § *Upgrade path*). This and Option B are two axes of the same idea — a plugin
declaring which capabilities and which policy it has — and would naturally land together. B
contributes stages and a pipeline; bundles contribute which of `{delivery, token}` the module
even has. Neither needs the other, but building them apart means two SPI reshapes instead of one.

**Invariants C3 must hold so that this stays a patch.**

- **PUSH and PULL remain a closed delivery union.** Do not add a fourth `deliveryPattern` to paper
  over a hybrid. That is the trigger above, not an extension of `'NONE'`.
- **`token` stays a facet with the same `generate` shape** on delivery plugins and on token-only.
  The bundle refactor copies that type; it does not rewrite it.
- **`getByDeliveryPattern('PULL')` never returns a token-only plugin.** Already true after C3
  (`'NONE'` is a different discriminant). The bundle registry just makes that structural.

### C4 — `PluginTuning` has four fields and zero real users

**Symptom.** The three delivery plugins declare byte-identical tuning, and half the fields are
meaningless for each pattern: PULL plugins carry `relayNodeInFlightTimeoutMs` and
`deviceInFlightTimeoutMs`; PUSH carries `initialPollDelayMs`.

**Evidence.** Identical four-field blobs in `calin-api-v1/index.ts:66-71`,
`calin-api-v2/index.ts:66-71`, `calin-chirpstack/index.ts:66-71`, and `stub/index.ts:51-56`
(one constant shared by both stubs). Three production delivery plugins plus the stubs; `nxt-sts`
has no `tuning` after C3.

```text
nsInFlightTimeoutMs:        20_000
relayNodeInFlightTimeoutMs: 900_000
deviceInFlightTimeoutMs:    12_000
initialPollDelayMs:         10_000
```

**Direction.** Core-owned defaults; plugins call `mergePluginTuning(entry)` and override only what
differs. The four-field `PluginTuning` type stays one type — after C2 the stage table is the
shared consumer, and splitting it into PUSH/PULL would make every `entryWaitMs` a type error
unless the engine kept a wide type anyway. Dead fields become something no plugin *writes down*,
not something the type system forbids. The poll ladder stays a core function of age.

**Done when.** No plugin restates a default it does not change.

**✅ Landed 2026-08-22.** `DEFAULT_PLUGIN_TUNING` + `mergePluginTuning(entry, overrides?)` in
`src/plugins/_shared/merge-plugin-tuning.ts`. All four delivery factories and both stubs call
`mergePluginTuning(entry)` with no delta. Per-plugin `*_DEFAULT_TUNING` constants and
`STUB_DEFAULT_TUNING` / `PROGRAMMABLE_DEFAULT_TUNING` are gone. ADR-002 amended.

### C5 — CALIN v1/v2 duplication: mostly leave it

The plugin audit found the dispatch shells of `calin-api-v1` and `calin-api-v2` are structurally
identical. **Do not abstract the vendor mapping.** The semantics genuinely differ — string `DataItem`
vs numeric `protocolId`, `'True'`/`'False'` vs numeric `0|1|2|3` status, unauthenticated POST vs a
JWT login stack with cache and 401 refresh. Two implementations do not justify an abstraction, and a
premature one would fight the third vendor rather than help it.

Worth sharing (byte-identical and vendor-neutral):

| Helper | v1 | v2 |
|---|---|---|
| `validateEnqueue` (same message string) | `index.ts:101-107` | `index.ts:106-112` |
| `_formatDate` safe-integer + UTC-rollover check | `outgoing.ts:100-123` | `outgoing.ts:82-98` |
| `ParsedResponseSlice` + `_createSuccessfulResponseData` | `incoming.ts:50-60` | `incoming.ts:49-59` |

Also noted: `src/plugins/_shared/generate-random-number.ts` (used only by `nxt-sts/token.ts`) and
`src/plugins/_shared/chirpstack-repository/` (used only by `calin-chirpstack`) are not shared. Leave
them where they are, but the `_shared/` name is misleading.

---

## D. Documentation

**Symptom.** The documentation is still shaped for an extraction in progress, and the extraction is
over.

**Evidence.**

- `docs/decisions-log.md` — 1778 lines. It is a session journal, and it is the first thing a cold
  reader is told to read.
- `docs/plans/001-extraction.md` — 330 lines describing finished work.
- `README.md:26-28` — "Still an extraction".
- Source comments carry markers that resolve to struck-through rows in another document: `Unit 5.4`,
  `(D5)`, `(D6)`, `(I3)`, `session 23c`, `ADR-006 D1`, `Phase 2`, `Intermezzo`. Measured: **70
  occurrences across 42 files** under `src/`.

**Why the source markers matter most.** To a human they are noise. To an AI they are worse than
noise — they look like navigable references and resolve to nothing local, so they invite exactly the
wrong lookup.

**Direction.**

1. Strip extraction/unit/session markers from `src/` comments. Mechanical, safe, highest daily value.
2. Archive `docs/plans/001-extraction.md` (keep it; mark it history).
3. Compress `decisions-log.md` into a short "state of the service + parked work" document; move the
   chronological journal to an archive section or file.
4. Update the README status paragraph to describe a standalone service.
5. Keep the ADRs. They are good and still normative.

**Done when.** A cold reader can orient from `README.md` + `AGENTS.md` + the ADR index without
reading anything about the extraction.

---

## Optional / low priority

| Item | Detail |
|---|---|
| Drop `ramda` | Four imports, four functions, all one-liners: `isNotNil` → `!= null`, `isEmpty` → `Object.keys().length === 0`, `fromPairs` → `Object.fromEntries`, `splitEvery(2, …)` → a loop. Sites: `engine/base.ts:11`, `engine/incoming.ts:8`, `redis-repository/index.ts:3`, `redis-repository/helpers.ts:1`. Removes a dependency and `@types/ramda`. |
| Spacing floor | `RESOLUTION_CYCLE_INTERVAL_MS = 2_000` (`engine/timers.ts:13`) is a hidden floor under `spacing` admission. `calin-chirpstack` declares `minIntervalMs: 2000`; the two agreeing is coincidence. Setting spacing below the tick silently has no effect. Document or clamp. |
| Check-then-claim race | `_canAdmit` reads the concurrency count (`outgoing.ts:126`) and `_onClaimAfterPick` writes the claim (`outgoing.ts:154`) as separate round-trips, with a Lua pick between. Every enqueue fire-and-forgets its own distribute pass, so concurrent passes can all see `tracked < maxInFlight` and transiently overshoot. Fold the claim into the pick. |
| `eventCorrelator` module state | `plugins/calin-chirpstack/lib/correlate-request-response.ts:33,119` — module-level `Map` plus a module-level `setInterval` started on import. Same convention mismatch as C1, much smaller blast radius. Deliberate per ADR-007; revisit only with multi-replica. |

---

## Settled during the review

Decisions reached with the maintainer. Recorded so they are not relitigated.

| Topic | Outcome |
|---|---|
| **Distribution throughput ("A6")** | **Dissolved — the original finding was wrong.** Distribution picks one message per queue per tick, but `maxInFlight` is still reachable because in-flight messages accumulate across ticks. Throughput = min(tick rate, `maxInFlight`/latency); the crossover is at 10s latency, and CALIN task latency is well above that (`initialPollDelayMs` alone is 10s). The concurrency cap binds, as designed; the tick rate does not. Residue is the spacing floor and the check-then-claim race, both moved to *Optional*. |
| **A3 severity** | Confirmed reachable in production — CALIN calls observed at up to 37 seconds against a 20s NS timeout. Rare but real; fix properly rather than patch. |
| **Ordering** | B1 first (no design needed, it is the safety net). Then settle C2's shape before A1–A4, because those four are symptoms of C2. Abandon C2 and write point fixes if its design proves sprawling. |
| **C1 scope** | Not a standalone project. Injecting a shallow module yields a shallow injected module. C1 follows C2. |
| **C5 scope** | Do not abstract the CALIN vendor mapping. Share only the three byte-identical helpers listed above. |
| **Queue priority** | The score on the initial `queue:{plugin}:{kind}:{id}` is `-priority`, so it orders messages **within** one queue. Queues do **not** have priority over each other: distribution scans queue keys in `SCAN` order and takes one message from each admissible queue. A high-priority message in queue X does not outrank a low-priority one in queue Y. That is correct — the queues partition by *device/relay-node*, which are independent contention domains — and it stays as is. |
| **C2 Redis layout** | Unchanged by the refactor. Same keys, members, scores, TTLs. C2 is code organisation only, which is what makes it verifiable and reversible. |
| **C2 tick** | One 1000 ms tick replaces the 2 s resolution cycle and 5 s PULL poll. PULL polling becomes punctual instead of rounded up to a 5 s boundary — accepted and desired. |
| **Branching** | Sequential branches, nothing straight to `main`. Branch 1 = `chore/post-extraction-refactor`, merged as PR #12 (B1, C2 design, B1b, C3). Branch 2 = `refactor/message-lifecycle-stage-table` (C2 + C1). Branch 3 = C4 (landed), D, Optional, capability bundles. |
| **Stage pipelines** | **Option A now** (two pipelines, keyed on `PUSH` / `PULL` as data — not on `DeliveryPattern`, which also has `'NONE'`). Option B (per-plugin pipelines with plugin-contributed stages and `advancedBy`) is fully designed in **ADR-008 § *Upgrade path*** and built only when its trigger fires. Option A must hold the four invariants listed there so B stays a patch. |

---

## Session notes

Append one short entry per landed item: what changed, anything the plan got wrong, and anything the
next session needs to know. Keep the detail in `docs/decisions-log.md`; keep this list scannable.

- **2026-08-19** — Plan created. Review complete, nothing implemented.
- **2026-08-19** — **B1 landed.** Valkey service container + `pnpm test:integration` step in
  `.github/workflows/build.yml`. Two corrections to the plan as written: the workflow file is
  `build.yml`, not `ci.yml`, and there are eight integration files, not seven. Landing it surfaced
  **B1b** — the suite is only 9 tests and covers happy paths only, so it is a harness rather than a
  safety net. B1b must land before C2 is *implemented*; the C2 design can proceed in parallel.
- **2026-08-20** — **C2 design settled**, nothing implemented. Seven decisions recorded under C2
  § *Design settled*: unchanged Redis layout, two kinds of queue, deadline ≡ next-poll-time,
  discriminated `onDue` result, table-owned edges, one 1000 ms tick, Option A pipelines. Option B
  written up in full as a deferred upgrade path with its trigger, its four concrete changes, the four
  invariants Option A must hold, and a worked SparkMeter example — so it never has to be re-derived.
- **2026-08-20** — Branch strategy corrected. Everything so far (B1, this plan) is already committed
  to **`chore/post-extraction-refactor`**, not `main`; the plan's earlier "on `main`" column was
  wrong. Branch 1 continues with **B1b** then **C3**, goes out for review, and merges. Branch 2 is
  cut from `main` after that merge and carries only the stage-table slice. Branch 1's scope is
  **C2's prerequisites only**; C4, D and Optional move to a branch 3 after the slice.
- **2026-08-20** — **B1b landed.** Integration suite is 12 files / 31 tests (was 8 / 9). New
  helpers: `programmable-plugin`, `redis-references`, `webhook-recorder`, `wait-for`. New specs:
  retry ladder, stage timeouts, orphans/cleanup, poll outcomes. Existing `incoming-poll.smoke.spec.ts`
  was left alone; PULL failure paths live in `incoming-poll-outcomes.smoke.spec.ts`. A1/A2/A3/A4
  are pinned as current (wrong) behaviour with markers — C2 should flip those assertions, not the
  Direction paragraph's "being scrubbed / always advancing" wording. The poll-outcomes spec matched
  production on the first run; nothing in the plan's description of current poll behaviour was
  wrong. Next: **C3**.
- **2026-08-20** — **C3 landed.** `DeviceMessagingPlugin` is now `PushPlugin | PullPlugin |
  TokenOnlyPlugin` on `deliveryPattern` (`'NONE'` for token-only). The plan was wrong that the
  `lifecycle.pull.ts` `fetchStatus` guard was only a type-system tax — it was also the runtime skip
  for `nxt-sts` (PULL with empty `incoming`). That is why C3 grew a third member instead of stuffing
  `nxt-sts` into PULL. `getByDeliveryPattern<P>` narrowing worked (generic mapped type + type
  predicate; test helpers widen to `DeviceMessagingPlugin[]` before filtering). Stub and
  programmable-plugin factories split into whole PUSH/PULL literals. `nxt-sts` unit test now asserts
  the token-only shape; the two tuning-merge tests went away with the unused fields (284 → 282 unit
  tests). C2 Option B's `Record<DeliveryPattern, …>` now includes `'NONE'` — exclude it when that
  ships. Next on this branch: review and merge.
- **2026-08-20** — Branch 1 docs closeout. Option B pipeline table keyed on `'PUSH' | 'PULL'`
  (not `DeliveryPattern`); C4 evidence recounts three delivery plugins + stubs, no `nxt-sts`
  tuning; decisions-log records B1b + C3 and strikes the token-only SPI discriminant. Branch 1
  is complete and awaiting review/merge. Branch 2 has not started.
- **2026-08-20** — Branch 1 review nits. Docs wording/MD040; test-helper DRY and typed
  `withStatus`; smoke keys from `initialQueueKey`; shared `createSinglePluginRegistry`.
  Settled calls left alone. Maintainer commits; still awaiting merge.
- **2026-08-20** — **Branch 1 merged (PR #12).** Branch 2 `refactor/message-lifecycle-stage-table`
  cut from `main`.
- **2026-08-20** — **ADR-008 written** (`docs/architecture/008-message-lifecycle-stage-table.md`),
  first commit on branch 2. It absorbs the plan's seven settled decisions unchanged and adds six
  that the plan had left to "the item-4 discussion", so C2 is implementation rather than design:
  cleanup/metrics key lists derive from the table (**A4**); the `ns` deadline does not fire while
  this process still holds the `sendOne` promise, using ADR-007's single writer — this is **A3**'s
  real layer, and the plan's alternative (a fetch deadline on the plugin client) is rejected in the
  ADR because aborting after vendor acceptance reproduces the duplicate command; the 48 h PULL cap
  moves into the `awaitingTask` action, which deletes a per-tick full ZRANGE of the whole queue;
  stages run concurrently within a tick with a per-stage re-entry guard, so collapsing three
  intervals into one does not serialise a slow `fetchStatus` ahead of NS timeouts; one TTL knob
  (**A5**); and enqueue's distribute kick keys off `engine.enabled` rather than
  `kickDistributeOnEnqueue` (**B3**). The plan's § *Design settled* and § *Option B* are now
  pointers — ADR-008 is the single source of truth. Two things for the C2 session to watch:
  `retryOrFail` and the shared incoming-event processor must start returning a `StageOutcome`
  instead of `void`, and `messageFullCleanup` needs the plugin (to derive the ready-queue key),
  which is the first pull toward **C1**. Next: item 4 (C2), and per the plan's C1 note, that
  session should write C1's concrete shape — which factories take the store, what the composition
  root looks like — into this plan while the context is cheap.
- **2026-08-20** — **ADR-008 reviewed and confirmed.** Decision 8 (the in-flight set) stays, with
  three additions: a 120 s plugin-client safety deadline so `sendOne` always settles; a bounded
  drain over the in-flight set, which C2 exposes and Shutdown v2 wires (stop timers → drain →
  close Redis, in that order); and the multi-replica form recorded under *Triggers* — the owner
  heartbeats the NS score rather than a scanner consulting process-local state, which is a
  known move rather than a rewrite. C2 therefore also touches the two CALIN clients (fetch
  deadline). Item 4 starts next.
- **2026-08-21** — **C2.1–C2.3 landed** (item 4). `src/engine/lifecycle/` now holds the table
  (`stages.ts`), the transitions (`moves.ts`), the per-stage actions (`actions.ts`) and the one
  runner (`runner.ts`); `lib/lifecycle.{push,pull}.ts` and `lib/queue-moving{,.push,.pull}.ts`
  are deleted, as are `runMessageResolutionCycle` and `pollPullPlugins` — three intervals
  collapsed into one 1000 ms `runner.tick()`. **A1 and A2 are fixed** (the runner scrubs
  orphans in every stage and always writes the next score, because the score is the runner's
  job and not the action's). **A4 is fixed** by C2.3: `StageMoves.purge` derives the sweep list
  from `enumerateStageKeys` plus the plugin's ready queue, and `messageFullCleanup(message,
  queueKeys)` no longer chooses; metrics' `KNOWN_STAGE_KEYS` is gone the same way, so a new
  stage row shows up in `/metrics` with no edit. Two deliberate behaviour changes to know
  about: cancel resolves the plugin before branching on status, so cancelling a `TO_RETRY`
  message whose plugin is unregistered is now `NOT_CANCELLABLE`; and the 48 h PULL cap fires on
  a message's next poll rather than in a full-queue scan, which the ladder bounds at 30 s.
  `messageFullCleanup`'s teardown callers in the smoke specs moved to the
  `purgeMessageReferences` helper, which was always the right tool there. Next: **C2.4** (A3).
- **2026-08-21** — **C2.4 landed** (**A3** fixed). `src/engine/in-flight-sends.ts`, one instance
  from `main.ts`, shared by the sender and the `ns` stage row; the row returns `rescheduled`
  while this process still holds the send. `moves.advance` now reads its own boolean and counts
  losses (`device_messaging_stage_claim_misses_total{stage}`), which is what A3 was hiding.
  `CLIENT_SAFETY_DEADLINE_MS` (120 s) on the CALIN V1/V2 and `nxt-sts` clients; ChirpStack kept
  its existing 60 s gRPC deadline. `outgoingService.drainInFlightSends(budgetMs)` is the
  shutdown seam, unwired until Shutdown v2. Full detail in `docs/decisions-log.md`
  **2026-08-21** C2.4.
- **2026-08-21** — **C2.7 written early, and the rest of C2 specified for handover.** The C1
  section above now carries its concrete shape (three ports, suggested order, two open
  questions), written while C2's context was still loaded rather than after it. The remaining
  two slices are execution against the spec below and need no further design input:

  **C2.5 — A5 and B3.**
  1. *A5.* `MESSAGE_TTL_SECONDS` (`src/lib/redis-repository/index.ts:30`) is the second source
     of truth. Delete it; give `enqueueDeviceMessage(dto, queueKey, ttlSeconds)` a third
     parameter and use it at both `expire` (line 198) and the correlation index `EX` (line 211).
     Its only caller is `outgoing.enqueue`, which already holds `delivery`, so it passes
     `delivery.messageTtlSeconds`. Nothing else imports the constant. The `indexTtlSeconds`
     rename the A5 section asks for is already done — it died with `lib/queue-moving.ts`;
     `moves.ts` passes `delivery.messageTtlSeconds` straight to the Lua's `index_ttl_seconds`.
     Confirm that and mark A5 closed rather than renaming anything.
  2. *B3.* Replace `kickDistributeOnEnqueue?: boolean` (default `true`) on
     `CreateOutgoingServiceOptions` with a required `engineEnabled: boolean`, passed from
     `config.engine.enabled` in `main.ts`. This is the decision B3 was waiting for: the flag
     stops being test support because it now names a real production condition — a service with
     the engine off accepts and stores commands but must not distribute, since no tick would
     follow up. In `test/helpers/engine-harness.ts` rename the option to `engineEnabled?:
     boolean`, keep the default `false`, and update the four specs that pass
     `kickDistributeOnEnqueue: false` (`outgoing-distribute` ×2, `outgoing-cancel`,
     `incoming-ingress`).

  **C2.6 — close out.** A1/A2 flipped in C2.2b, A4 in C2.3, A3 in C2.4, so no pinned assertion
  should remain; verify that rather than assume it. Then sweep comments and JSDoc for names the
  refactor deleted — `resolution cycle`, `runMessageResolutionCycle`, `pollPullPlugins`,
  `queue-moving`, `lifecycle.push` / `lifecycle.pull`, `fromAnyToRetry` — and fix the ones that
  now describe code that no longer exists. Finish on a green
  `pnpm lint && pnpm typecheck && pnpm test && pnpm build`, then `pnpm test:integration` with
  Valkey up. Then C2 is closed and **C1** starts from the section above.
- **2026-08-21** — **C2.5 landed** (**A5** and **B3**). `MESSAGE_TTL_SECONDS` deleted;
  enqueue takes `ttlSeconds` from `delivery.messageTtlSeconds`. `kickDistributeOnEnqueue`
  is now required `engineEnabled`, passed from `config.engine.enabled`. Next: **C2.6**.
- **2026-08-21** — **C2.6 landed.** Pins already flipped (A1–A4). Stale names swept from
  live comments/JSDoc/ADR current-behaviour rows. **C2 closed.** Next: **C1**.
- **2026-08-21** — **C1.1 landed.** Deleted the four dead `redisRepo` methods. Next: **C1.2**.
- **2026-08-21** — **C1.2 landed.** `createRedisClient` + `createRedisRepo(client)`. The
  process-wide `redisRepo` remains until the stores are injected. Next: **C1.3**.
- **2026-08-21** — **C1.3 landed.** `createAdmissionStore({ client })` — four methods,
  injected into `createOutgoingService`. Methods removed from `redisRepo`. Next: **C1.4**.
- **2026-08-21** — **C1.4 landed.** `createMessageStore({ client })` — five CRUD methods,
  injected into outgoing, incoming, base, and the runner. Incoming no longer imports
  `redisRepo`. Next: **C1.5**.
- **2026-08-21** — **C1.5 landed.** `createStageStore({ client })`. `createRedisRepo` gone;
  `redisRepo` is `{ client }`. Orphan ZREM dropped from `base.retryOrFail` (runner A1).
  **C1 closed.**
- **2026-08-22** — **C1 closeout.** Deleted `redis-repository/index.ts`. Process-wide
  client is `redis` from `client.ts`. Shared `assertExecSucceeded`. Checklist items
  4–8 ticked.
- **2026-08-22** — **C4 landed.** `DEFAULT_PLUGIN_TUNING` is the one four-field blob;
  `mergePluginTuning(entry, overrides?)` layers core → plugin delta → config. No plugin
  restates a default. `PluginTuning` was **not** split by pattern — the stage table is
  one consumer. Poll ladder stays core-owned. Next: **D**.
