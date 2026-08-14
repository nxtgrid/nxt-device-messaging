# Decisions Log — nxt-device-messaging

Chronological record of decisions and deviations, appended every working session. Format:
`YYYY-MM-DD — note`. Architectural decisions get a full ADR in `docs/architecture/`; this log
records what happened, when, and what is still open — the things an ADR is the wrong shape for.

**Read this first when picking up work after a gap.** It is the only place that tells you what is
settled versus still open. Parked follow-ups live in **Parked / revisit** below — not in the
chronological log and not duplicated in the plan.

---

## Open decisions

Ordered by dependency. Nothing below is decided; do not act on any of it without the maintainer.


| #   | Decision                                                                       | Blocked on |
| --- | ------------------------------------------------------------------------------ | ---------- |
| —   | *(none blocking; **4.1B done**; **next = 4.1C** queue-depth gauges)* | —          |


## Parked / revisit (canonical)

Living list of work that is **intentionally not next**. Do not add parallel lists in
`AGENTS.md` or the extraction plan — point here. When an item lands, strike it and note
the session in the log. Detail stays in the cited ADR, D-row, or log heading.

### This repo

| Item | Revisit when | Detail |
| --- | --- | --- |
| **Shutdown v2** — await in-flight engine ticks + webhook `drainChain`; optionally gate `storeAndEmit` after shutdown starts. v1 only stops timers then closes Fastify/Redis. Thin option: webhook `stop()` awaits current `drainChain` (bounded by `requestTimeoutMs`) | Before cutover, or when reopening shutdown | ADR-005 amendment; log **2026-08-12** parked shutdown |
| **Webhook drain concurrency** — drain is serialized in-process | Serialized drain lags under event volume | 3.1 closeout; log **2026-08-12** cold-start / 3.1E notes |
| **ChirpStack ingress enqueue-then-ack** — vendor HTTP posts once and does not retry; v1 awaits `handle` before 204 for *local* Redis durability only | Designing durable raw-event enqueue → 204 → async process | Log **2026-08-13** parked ingress |
| **D2 + thorough cleanup suite** — `messageFullCleanup` options; every exit must drop the hash and all references. Includes PULL poll↔retry orphan on `queue_awaiting_retry` | Dedicated integration suite / remaining cleanup paths | ADR-006 **D2**; carried finding “Thorough message-cleanup tests”; log **2026-08-04** review nits |
| **Plugin HTTP hygiene** — redact `decoderKey` (and CALIN bodies) in error logs; map vendor token errors to useful HTTP statuses; generous fetch safety deadline (not abort-at-NS-timeout); trailing-slash base URLs | A sanitization / client-hardening pass | Log **2026-08-05** NS_SLOW / fetch; **2026-08-06** sanitization pass |

### Product / ops trigger

| Item | Revisit when | Detail |
| --- | --- | --- |
| Message-bus adapter for delivery events | A consumer needs broker delivery | ADR-003; was plan 001 Deferred |
| Dead-letter admin / replay HTTP | Ops needs DLQ replay without Redis access | ADR-003 |
| Debug HTTP to run distribute / poll once | Manual smoke against timers becomes painful | Plan Intermezzo / Unit 5 working rule |
| HA / multi-replica (leader election, Redis-backed correlator) | Operator needs >1 replica | **ADR-007**; `nxt-backend` ADR-010 §6 |
| Domain rename (`DeviceMessage` → dispatch-flavoured) | Rejected for the extraction; only if the service is real and test-covered | ADR-001 Rejected |

### Other repo (`nxt-backend`)

| Item | Revisit when | Detail |
| --- | --- | --- |
| **Cutover addendum** — hard stop-then-start (not blue/green); ChirpStack integration URL flip; drain old Valkey; provision this service’s Valkey/config/secrets; webhook rehearsal in a window with no rollback; early-adopter CALIN/ChirpStack question | Authoring company cutover vs `nxt-backend` ADR-012 | Carried findings (cutover rows) |
| **`meter-installs` vendor clients** — ChirpStack `registerDevice` / `setApplicationKeyForDevice` and CALIN v2 repo still imported by hardware provisioning | Metering import (002f) | Carried finding; plan coupling note |
| Re-cut `nxt-backend` plan 001 into a per-repo pair | Optional; mechanics settled | Open-decisions blurb; decision 5 |

---

## Deferred with locked criteria

These are **not** free-for-all open questions. Criteria and interim seams live in the cited ADR.
Revisit only in the named unit; record the choice in this log and amend the ADR if needed.


| #      | Topic                                                                                                                | Revisit at                               | Interim until then                                                                                                                                                        | ADR |
| ------ | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| ~~D1~~ | `queueKey → pluginId` → **C embed** `pluginId` **in key** (session 18b; reverts 18/B)                                | —                                        | —                                                                                                                                                                         | 006 |
| D2     | Whether `messageFullCleanup` needs more than `inFlightQueueKeys[]` + `concurrencyRateLimitKey`                       | Remaining cleanup paths / thorough suite | Parameterized options on the Redis repo; derive key via `buildConcurrencyRateLimitKey`; send-fail path passes key when concurrency; incoming success cleanup does not yet | 006 |
| ~~D3~~ | ~~Wire named admission into~~ `distribute` → **landed** on `OutgoingService.distributeToNetworkServers` (session 19) | —                                        | —                                                                                                                                                                         | 006 |
| ~~D4~~ | Plugin-local key vocabulary → **landed** (session 29): Units 7/9 `dcu`; Unit 8 `none`; Unit 10 `network`            | —                                        | —                                                                                                                                                                         | 006 |
| ~~D5~~ | ~~Stage timeouts → plugin~~ `tuning` → **landed** (session 23c)                                                      | —                                        | —                                                                                                                                                                         | 002 |
| ~~D6~~ | ~~Wire parent-node name~~ → `device.relayNode` **landed** (session 23c)                                              | —                                        | —                                                                                                                                                                         | 003 |


Decisions 5 (transfer mechanics + phase order), 6 (scope), **7 (tooling → ADR-004)**,
**8 (public HTTP contract → ADR-003)**, **9 (deployment / OSS hygiene → ADR-005)**, and
**10 (bottleneck + admission → ADR-006)** are **settled** — see the log below and
`docs/plans/001-extraction.md`.

**Course correction (2026-07-30):** Phase 1b Intermezzo **closed** (I0–I3; I4 skipped).
End-to-end rule (session 16): ADR-003 command/ingress surfaces land thin HTTP with the
engine chunk; timer-only paths use stub plugins + enqueue/get. See sessions 12–19 and
plan **Phase 1b** / Unit 5.

Phase 0 scaffold is **done**. Phase 1 through Unit **6** is **done**. Intermezzo closed.
Phase 2 **Units 7–10** (`calin-api-v1`, `nxt-sts`, `calin-api-v2`, `calin-chirpstack`) are
**done**. **Phase 3** (**3.1–3.3**) **closed**; **Phase 4** in progress
(**4.1A–B done**; **next = 4.1C**). Cold starts: trust `AGENTS.md` + this log
+ `docs/plans/001-extraction.md` — not prior chat transcripts.
Also outstanding on `nxt-backend` (see **Parked / revisit → Other repo**):

- Re-cutting `nxt-backend`'s plan 001 into a per-repo pair.
- The device-messaging **cutover addendum**, reconciled with `nxt-backend` ADR-012.

---



## Carried findings

Facts established during planning that are not yet reflected in the documents they contradict.
Each needs to land somewhere before it can be dropped from this list.

**Actionable parked work is in Parked / revisit above** — do not treat this table as the
to-do list. Rows below are leftover facts (many already struck).


| Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Lands in                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Thorough message-cleanup tests (wanted).** Enqueue into an empty DB creates **four** Redis entries: `device_message:{id}`, correlation `idx`, bottleneck queue membership, and `queues_to_distribute_from`. Messages then pass through stage queues; at every exit (cancel, success, final fail, timeout) the message **and all references** must be gone. `messageFullCleanup` today does not SREM `queues_to_distribute_from` (distributor Lua GC's empty queues). Build a dedicated integration suite once distribute + more exit paths exist — not only enqueue→cancel→get smoke                                                  | Integration tests / D2 exit-path audit                                                        |
| **Vendor clients are shared with** `meter-installs`**.** `lib/chirpstack-repository/index.ts` (`registerDevice`, `setApplicationKeyForDevice`) and `adapters/calin-api-v2/lib/repo.ts` (`sendCalinApiV2Request`, `CalinApiV2Error`) are imported by `meter-installs/adapters/{calin-lorawan,calin-api-v2}/_install.service.ts`, which stays in `nxt-backend`. Extracting them leaves nxt-backend's hardware provisioning without its vendor clients. **Out of scope here, undecided** — three eventual options: re-implement thin provisioning clients in Metering, expose provisioning endpoints from this service, or share a package | `nxt-backend` Metering import (002f)                                                          |
| `nxt-backend` ~~plan 001's Phase 1 cannot execute — it edits files in the frozen~~ `legacy/` ~~tree~~                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | ✅ ADR-010 amendment §B, plan 001 stop-banner, `docs/plans/001-extraction.md`                  |
| `nxt-backend` ~~ADR-010 decision 2's endpoint list has **no token endpoint~~**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | ✅ ADR-010 amendment §C, then **ADR-003** (`POST /token/generate`)                             |
| ~~Cancel had zero callers; Decision 6 deferred the route~~                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | ✅ **ADR-003** ships single + batch cancel anyway (logic already existed; useful for adopters) |
| Plan 001's external-import table understates the coupling: `@core/types/device-messaging` appears in **8** files (not 3), `@core/types/supabase-types` in **5** (not 1), `@helpers/number-helpers` in **4** (not 1)                                                                                                                                                                                                                                                                                                                                                                                                                     | Plan re-cut (decision 5)                                                                      |
| `adapters/calin-lorawan/lib/_UNUSED_EXAMPLE_correlate-request-response.redis.ts` is dead code and should not travel                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Decision 6                                                                                    |
| Baseline commit `db5c2ac` made `grid_id` nullable and added `LORAWAN_UNASSIGNED_BUCKET` (`queue:lorawan_network:unassigned`). This invalidates plan 001 task 1.6's target type (`network_id: number`) and task 3.3's example `bottleneckKey`, which would route orphan meters to `queue:lorawan_network:null` and lose them                                                                                                                                                                                                                                                                                                             | Plan re-cut (decision 5)                                                                      |
| Device-messaging cutover is **hard stop-then-start, not blue/green** — ChirpStack posts to exactly one integration URL, and dual polling of a vendor API double-processes. Same mechanics `nxt-backend` ADR-012 decision 2 assigns to `worker`                                                                                                                                                                                                                                                                                                                                                                                          | Cutover addendum                                                                              |
| `nxt-backend` ADR-012's step-4 sequence is missing three device-messaging items: the ChirpStack integration URL flip, an in-flight drain of the old Valkey, and provisioning this service's own Valkey plus config and secrets ahead of the window                                                                                                                                                                                                                                                                                                                                                                                      | Cutover addendum                                                                              |
| Under wholesale cutover this service carries **zero production traffic until cutover day** — so ADR-010's self-identified riskiest interface (the outbound webhook) is first exercised inside a window with no rollback past it (`nxt-backend` ADR-012 decision 5). Needs the rehearsal step attached                                                                                                                                                                                                                                                                                                                                   | Cutover addendum                                                                              |
| **Open question for the cutover addendum:** does the early adopter (`nxt-backend` roadmap deployment consumer #3) run CALIN meters and ChirpStack? If so they are the natural first production user *before* the company, which retires most of the above risk                                                                                                                                                                                                                                                                                                                                                                          | Ask the maintainer when authoring                                                             |
| ~~**ChirpStack** `?event=` **routing**~~ — ops confirmed (`event: 'up'`, also `status` / `log`); SPI `handle(event, meta?)` with `IncomingHandleMeta.query`; ingress flattens query; `calin-chirpstack` switches on `txack`/`ack`/`join`/`up`, fail-closed when missing/unhandled                                                                                                                                                                                                                                                                                                                                                                                                                          | ✅ session 31                                                                                 |
| **Graceful shutdown v2 (parked).** Await in-flight engine ticks + webhook `drainChain` on stop; optionally gate `storeAndEmit` after shutdown begins. v1 only clears intervals then closes Fastify/Redis. Thin interim: webhook-only await of `drainChain`                                                                                                                                                                                                                                                                                                                                                                                    | Follow-up when reopening shutdown (ADR-005)                                                   |


---



## Log



### 2026-07-27 — session 1: framework, docs split, naming, configuration

Extraction planning began. `nxt-backend`'s plan 001 was found to be materially stale — written
2026-07-02, before the OSS migration moved the source module into a frozen `legacy/` tree — so the
session went to re-deciding the foundations rather than executing the plan.

**Decided:**

- **Fastify + Zod, no DI container, plain-object plugins** → **ADR-001**. Measured the module's real
NestJS footprint (8 `@Injectable`, 1 module, 4 DI constructors, 2 crons, zero controllers) and
found the plan already dismantles all of it by task 3.7. Supersedes `nxt-backend` ADR-010
decision 1 on the framework only.
- **Documentation split.** This repo owns *how the service is built* — its own ADR numbering from
001, its own plans, its own `AGENTS.md`, and the normative consumer contract (OpenAPI plus an
integration guide). `nxt-backend` keeps *why the extraction happens* and what changes on its
side, including the company cutover addendum, which cannot live in an OSS repo because it
concerns a private one. `nxt-backend` ADR-010 is amended, not rewritten.
- **Name** `nxt-device-messaging` **stands.** The rename to `nxt-device-dispatch` was considered and
**declined**: the internal vocabulary is message-centric throughout (`DeviceMessage`,
`CreateDeviceMessageDto`, the `device_messages` keyspace, both Lua script names,
`runMessageResolutionCycle`), so renaming the artifact alone relocates the mismatch, and renaming
the vocabulary too would touch the Redis key schema and Lua scripts during a move meant to
preserve behaviour. The real concern behind the rename — that "messaging" reads as SMS, which the
estate genuinely also does — is addressed by README positioning and a "What this is not" section
instead. Recorded as declined so it is not relitigated. Derived identifiers: npm
`nxt-device-messaging` (private), env prefix `DEVICE_MESSAGING_*`, type `DeviceMessagingPlugin`,
image `ghcr.io/nxtgrid/nxt-device-messaging`.
- **Configuration follows** `nxt-backend` **ADR-007's mechanism, adapted** → **ADR-002**. JSON artifact
for topology, non-secret settings, and tuning; secrets in env only; plugin-contributed Zod schemas
composed at registration; plugin tuning defaults in code, overridable by config. Two deliberate
behaviour changes from the inherited module: `engine.enabled` replaces `NXT_ENV !== 'production'`
cron gating (which made the engine inert outside production), and `HERMES_*` becomes `REDIS_*`.

**Established as fact:**

- The source module is **frozen at** `db5c2ac` and at parity with company production; neither
`legacy/` nor the private repo will be updated again. No drift-checking needed. Earlier concern
about `legacy/` being a moving target was corrected by the maintainer.
- The company adopts this service **as part of the single wholesale OSS cutover**, not before it.
No HTTP client is retrofitted into legacy tiamat; `legacy/` is never edited. Consequence: this
service's only consumer, ever, is the imported `meter-interactions` in the new `apps/api`.
- `LICENSE` is already **MPL-2.0**, byte-identical to `nxt-backend`'s. This closes plan 001 task
4.4's open question ("MIT or Apache 2.0 — confirm with maintainer"): neither, and it is already
in place.
- The real consumer surface is **five** in-process call sites, not the four plan 001 lists —
`enqueue`, `subscribe`, `getMessageByMeterInteractionId`, `handle`, and the omitted
`deviceTokenService.generate`.

**Written:** `README.md` (positioning plus honest under-construction status), the GitHub
description, `AGENTS.md`, ADR-001, ADR-002, and this log. In `nxt-backend`: ADR-010's
"Amendment (2026-07-27)" (eight lettered parts, plus inline markers on decisions 1, 2, 4) and a
stop-banner on plan 001 marking it stale and non-executable.

### 2026-07-27 — session 1 (continued): transfer mechanics, phase order, scope

**Decided — transfer is an incremental port, not a copy.** Code is ported **unit by unit** directly
from `nxt-backend`'s frozen `legacy/` tree into `src/`, tracked by an **import ledger** (the same
device the `nxt-backend` 002 roadmap uses). No staging `legacy/` folder in this repo — that would be
a second frozen copy of code already frozen one repo away. Git history is **not** preserved:
incremental hand-porting rules out `filter-repo` grafting regardless, the history stays permanently
in `nxt-backend` one link away, and these files are substantially rewritten within two phases anyway.
Provenance is recorded instead (`AGENTS.md`, baseline `db5c2ac`).

**Decided — five phases, ten units.** Full detail in `docs/plans/001-extraction.md`. Two departures
from `nxt-backend` plan 001:

- **Scaffold becomes its own phase (0).** Plan 001 buried it in task 2.1, which worked when there was
a NestJS module to lift; with no framework inherited, the scaffold must exist before code lands.
- **Plugins come before HTTP** (phases 2 and 3 swapped relative to plan 001). Plan 001 already
contradicted itself here — its task 2.3 declares a dependency on task 3.1 — and endpoint DTOs
depend on the field renames and plugin ids, while ADR-002's config needs plugin-contributed
schemas. Plugins-first removes a circular dependency.

**Deviation recorded:** adapters are ported **directly into plugin shape**, one pass rather than
port-then-convert. Plan 001 task 3.4 describes the plugin object as "a thin wrapper," so porting each
adapter twice is waste. This merges move-and-modify more than `nxt-backend` ADR-008 prefers; the
per-unit review plus the ledger is the accepted control.

**Decided — scope.** `_UNUSED_EXAMPLE_correlate-request-response.redis.ts` dropped (dead code).
`device-messages.module.ts` dropped (superseded by the composition root). `nxt-sts` travels. The
**cancel endpoint is deferred** — `cancelOneByCorrelationId` and `cancelManyByCorrelationIds` have
zero callers in `legacy/`; the Redis methods port, the route does not, and `nxt-backend` ADR-010's
commitment to `DELETE /messages/:correlationId` is speculative.

**Corrected — CALIN V1 stays, actively supported.** V1 meters are in the field. An earlier suggestion
that V1 might be retired was a **misreading** of `nxt-backend` ADR-006 decision 6, which deprecates
the `talos` **app** (whose job was CALIN-v1 hardware provisioning), not the CALIN V1 protocol. V1 is
also the second real adapter, so it is what validates the plugin SPI per `nxt-backend` ADR-001.

**Clarified — hardware provisioning is out of scope.** `meter-installs` has its own adapters and is
not part of this service. No decision has been made about ever absorbing it, and none is needed here.
The one real consequence is the shared-vendor-client finding above.

### 2026-07-27 — session 2: Decision 8 — public HTTP contract

**Decided → ADR-003.** Normative consumer contract for this service; supersedes the incomplete
endpoint inventory in `nxt-backend` ADR-010 decision 2 for everything on this side of the wire.

**Command API** — action paths, singular/plural for cardinality:

- `POST /message/enqueue`, `GET /message/:correlationId`
- `POST /message/cancel`, `POST /messages/cancel` (single + batch; Decision 6's deferral of the
*route* is reversed — Redis logic was always there)
- `POST /token/generate` (sync; closes the ADR-010 §C gap)
- `POST /ingress/:pluginId` (plugin `verifySignature`, opt-out allowed)

**Auth:** Bearer static API key (`DEVICE_MESSAGING_API_KEY`) on command routes only — not on ingress.

**Renames throughout the pipeline** (HTTP, Redis, indexes, logs — no boundary-only translation):
`correlation_id`, `network_id`, `command_type`. Aligns with ADR-010 and estate `command_type`
vocabulary (`nxt-backend` ADR-011).

**Plugin selection:** required `pluginId` on enqueue/token; drop `manufacturer` + `protocol` from
the public contract. Bundled ids: `calin-chirpstack` (renamed from `calin-lorawan` — manufacturer +
network server, not protocol), `calin-api-v1`, `calin-api-v2`, `nxt-sts`. `command_type` is a
string to the core; each plugin closes and validates its own set.

**Outbound webhook** (replaces `subscribe()`):

- Same event set as today's `publish()` (first `SENT_TO_NS`, terminal success/failure, unsolicited);
expandable later
- Envelope: `eventId`, `occurredAt`, `pluginId`, `message { … }` (camelCase JSON)
- HMAC-SHA256 signing **opt-in** (secret unset → unsigned + boot warn); not the inbound API key
- Async delivery, bounded retries, Redis dead-letter under `webhook:*` on the **same** Redis DB;
engine never blocks; device outcome independent of callback success
- Message bus deferred

**Written:** ADR-003. `AGENTS.md` ADR index, `docs/plans/001-extraction.md`, and ADR-002's example
plugin id (`calin-chirpstack`) updated in the same session.

### 2026-07-28 — session 3: Decision 7 — tooling stack

**Decided → ADR-004.**


| Concern         | Choice                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| Package manager | pnpm (Corepack `packageManager` pin; exact patch at scaffold)                                           |
| Node            | 24.x (current LTS major; `engines`)                                                                     |
| Module system   | ESM (`"type": "module"`)                                                                                |
| Build           | tsup (esbuild); Lua scripts copied beside output                                                        |
| Dev / scripts   | tsx                                                                                                     |
| Tests           | Vitest                                                                                                  |
| Lint            | ESLint 9 flat + typescript-eslint; house `teamRules` adapted (no Nx, no estate-only restricted imports) |


**Explicitly rejected:** Prettier, Biome, `@stylistic/eslint-plugin`, Jest, webpack/`tsc`-only as
primary build. Style stays in ESLint core rules as in `nxt-backend/eslint.config.mjs`.

**Unblocks** Decision 9 (Docker/CI/hygiene). Phase 0 can use this stack; compose/CI half of Phase 0
and Phase 4 still wait on Decision 9.

**Written:** ADR-004. `AGENTS.md` ADR index, open-decisions table, and `docs/plans/001-extraction.md`
header/status notes updated.

### 2026-07-28 — session 3 (continued): Decision 9 — deployment and OSS hygiene

**Decided → ADR-005.** Patterns aligned with sibling OSS service `nxt-sts` (tag → GHCR, image
HEALTHCHECK, PaaS-from-GitHub health note), adapted for Valkey.


| Concern    | Choice                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| Dockerfile | Multi-stage `node:24-slim`; non-root; `HEALTHCHECK` → `/healthz`                                            |
| Compose    | App + Valkey 8 alpine; `.env.example`; `.dockerignore`                                                      |
| Port       | **3100** (misses estate api 3000 and `nxt-sts` 8080)                                                        |
| CI         | `build.yml` (PR + default branch: lint/test/build); `release.yml` (tags `v*.*.*` → GHCR `:tag` + `:latest`) |
| Metrics    | `GET /metrics` Prometheus via `prom-client` (min: queue depth, terminal status counters, retry histogram)   |
| Health     | `GET /healthz`; README documents image HEALTHCHECK vs PaaS probe (nxt-sts dual-path note)                   |
| Logging    | Fastify pino, JSON in production                                                                            |
| Hygiene    | `CONTRIBUTING.md`, issue-template stubs; LICENSE already MPL-2.0                                            |


**Phase split:** Phase 0 lands Docker/compose/CI stubs; Phase 4 lands metrics, pino sweep,
CONTRIBUTING polish, README deploy/health section.

**Open decisions in this repo:** none. Next work is Phase 0 scaffold execution.

**Written:** ADR-005. `AGENTS.md` ADR index, open-decisions table, and `docs/plans/001-extraction.md`
updated.

### 2026-07-28 — session 4: Phase 0 scaffold execution

Executed Phase 0 end-to-end (prior sessions had locked ADR-001–005; this session ran the
scaffold).

**Landed:**

- **Tooling / hooks** (Steps 1–1b, earlier in Phase 0): [pnpm@11.17.0](mailto:pnpm@11.17.0), Node 24, ESM, tsup, tsx,
Vitest, ESLint (house teamRules adapted), husky + lint-staged; pre-commit = lint-staged then
`pnpm typecheck`.
- **Config loader** (Step 2): async `loadConfig` (JSON → URL → PATH → `config.default.json`),
`getConfig` / `setConfig`, Zod schema, `config.default.json` + `config.example.json`, unit
tests under `test/unit/`.
- **Fastify shell** (Step 3): `buildApp()` + `GET /healthz` → `{ ok: true }`; listen on
`0.0.0.0`, port from `PORT` (default **3100**). Liveness stub landed early so the image
`HEALTHCHECK` has a target; Redis-aware readiness stays Phase 4 / a later `/readyz` if needed.
- **Deployment stubs** (Step 4): multi-stage `Dockerfile` (`node:24-slim`, non-root,
`HEALTHCHECK` → `/healthz`), `docker-compose.yml` + Valkey 8 alpine, `.env.example`,
`.dockerignore`, `build.yml` + `release.yml` (tag → GHCR).

**Deviations / notes:**

- Dockerfile: `pnpm prune --prod` must use `--ignore-scripts` — after prune, `prepare` would
invoke `husky` which is already gone. Verified: image build + container `/healthz` → 200.
- **Ramda:** used lightly in the frozen source (`isNil` / `isNotNil` / `isEmpty`, plus
`fromPairs` / `splitEvery` in redis helpers). **Keep on port** (Phase 1 unit 2+); do not add
for Phase 0 shell code. Formal dep lands with the first port unit that needs it.
- `/healthz` path kept (k8s/`*z` convention); not Spring `/actuator/health` (`nxt-sts`). Port
env is `PORT`, not `SERVER_PORT`.

**Phase 0 closed.** Next: Phase 1 unit 1 (types and utilities). Docs updated this session:
`AGENTS.md` status, plan 001 Phase 0 → Done, this log entry.

### 2026-07-28 — session 5: Phase 1 Unit 1 (core types)

**Landed:** `src/lib/types.ts` — core domain types from frozen `lib/types.ts` (baseline
`db5c2ac`) with ADR-003 renames (`correlation_id`, `network_id: number | null`,
`command_type`), required `pluginId: string`, identity-only `device`, local `PhaseEnum`.
`CreateDeviceMessage` replaces the Nest DTO shape in-domain (HTTP Zod stays Phase 3).
`response.data` is `Record<string, unknown>` (an object; plugins own the shape) — not a
recursive `Json` union and not the estate’s `Record<string, any>`.

**Deviations from the Unit 1 sketch in plan 001 (pre-session wording):**

1. **No core** `lib/utils.ts`**.** `generateRandomNumber` and `toSafeNumberOrNull` are only used
  by adapters → deferred to plugin units 7–10.
2. **No token / phase-read predicates in core.** Those encode CALIN command vocabulary;
  ADR-003 §4 says plugins close `command_type`. Predicates land with the plugins that need
   them (verify strings against `meter-interaction-type-helpers` at that time — including
   `DELIVER_PREEXISTING_TOKEN`, not the stale plan’s `DELIVER_TOKEN`).
3. **No** `NetworkServerImplementation` **/** `PULL_PATTERN_IMPLEMENTATIONS`**.** Core must not
  hardcode which plugin ids are PULL. Each plugin will declare PUSH vs PULL on the plugin
   interface; the registry (Unit 6) exposes that to the engine. PULL awaiting-task keys use
   `pluginId` (ADR-006); initial queues use plugin `bottleneckKey`, not a core switch.
4. **No** `BUNDLED_PLUGIN_IDS` **in core.** Bundled ids live in ADR-003 and on each plugin
  object; core only carries opaque `pluginId: string`.

**Phase stays in core** — Redis correlation indexes append `_ph{phase}` when phase is set,
because multi-phase reads enqueue one message per phase.

**Checks:** `pnpm typecheck` / `lint` / `test` / `build` green.

**Next:** Phase 1 Unit 2 (Redis repository + Lua) after review.

### 2026-07-29 — session 6: ADR-006 bottleneck + admission

**Decided → ADR-006** (named strategies; plugins do not re-copy canDistribute/onClaim).

**Locked:**

- Plugins own `bottleneckKey(message) → string`; core omits `queueInitial`.
- Queue key shape `queue:{kind}:{id}` is a naming convention; `{kind}` vocabulary is
plugin-owned (e.g. keep `gateway` or rename to `dcu` in the CALIN plugins only).
- Admission declared as `spacing` | `concurrency` | `custom`; core implements the first two
primitives; knobs via plugin tuning / ADR-002 config.
- `deliveryPattern` remains separate from admission.
- Distributor must not branch on topology strings for policy.

**Deferred with criteria in ADR-006 (D1–D4):** `queueKey → pluginId` mapping (Redis vs
boot-time kind registry — **safe to decide at Units 5–6**; no Unit 2 dependency);
`messageFullCleanup` shape beyond interim `inFlightQueueKeys[]`; wiring distribute;
cosmetic key names. Decisions-log “Deferred with locked criteria” table points cold
sessions at the ADR so another model cannot treat these as blank-slate open questions.

**Unit 2 interim seams (when driven):** omit `queueInitial`; parameterized cleanup queue
list; no admission engine / owner map yet.

**Written:** ADR-006; `AGENTS.md` index; plan Units 2/5/6 updated; this log.

### 2026-07-29 — session 7: Phase 1 Unit 2 (Redis repo + Lua)

**Landed:** `src/lib/redis-repository/{index,keys,helpers}.ts` and `src/lib/redis-repository/lua/{fetch-next-message-in-queue,move-message-between-queues}.`* plus their TS type companions.

Ported field renames: `correlation_id` (string), `network_id` (`number | null`, omitted when null), `command_type`.
Index prefix: `idx:correlation_id:`.

Per ADR-006: `queueInitial` omitted; `queueAwaitingTask(pluginId)` added.
Lua scripts are loaded from local `.lua` files and copied into `dist/` at build time.

**Deviation:** `messageFullCleanup` supports optional `inFlightQueueKeys` (defaults to known
stage keys + `queue_awaiting_task:{pluginId}`) and optional `concurrencyRateLimitKey`
(no gateway default — refined in session 7b).

**Checks:** `pnpm typecheck` / `lint` / `test` / `build` green.

### 2026-07-29 — session 7b: Unit 2 review cleanups

- `createRedisClientOptions()` returns the final iovalkey options object (incl. optional `tls`).
- Dropped core `LORAWAN_UNASSIGNED_BUCKET` and `gatewayRateLimit` key builder (plugin vocabulary).
- Gateway-named rate-limit methods → ADR-006 concurrency primitives on the repo:
`addToConcurrencyRateLimit` / `getConcurrencyRateLimitCount` /
`validateAndCleanConcurrencyRateLimit` (opaque `trackKey`).
- `messageFullCleanup` no longer invents a gateway rate-limit key; caller may pass
`concurrencyRateLimitKey`.



### 2026-07-29 — session 7c: Unit 2 docs sync + Redis smoke test

- Synced `AGENTS.md` / plan Phase 1 status to Units 1–2 done; ADR-006 D2 interim names
`concurrencyRateLimitKey` and notes remaining exit-path audit.
- Added opt-in smoke: `test/integration/redis.smoke.spec.ts` —
`RUN_REDIS_SMOKE=1 pnpm exec vitest run test/integration/redis.smoke.spec.ts`
(Valkey up). Default `pnpm test` skips it.



### 2026-07-29 — session 8: Phase 1 Unit 3 (queue primitives)

**Landed:** `src/lib/queue-moving.ts`, `queue-moving.push.ts`, `queue-moving.pull.ts`,
`retry-helpers.ts`.

**Deviations / ADR alignment:**

1. **Config-backed stage + retry knobs.** Extended `delivery` schema with
  `nsInFlightTimeoutMs` (20s), `gwInFlightTimeoutMs` (15m), `deviceInFlightTimeoutMs` (12s),
   `initialPollDelayMs` (10s) — same legacy values as in-code defaults. Retry helpers and
   `_moveQueue` TTL read `getConfig().delivery.*` (`MAX_RETRIES` → `getMaxRetries()`).
2. **PULL uses** `pluginId`**.** `fromNsToAwaitingTask({ pluginId })` →
  `queueAwaitingTask(pluginId)`; dropped `NetworkServerImplementation`.
3. `fromAnyToRetry` **concurrency seam.** Optional `concurrencyRateLimitKey` (SREM), mirroring
  Unit 2 `messageFullCleanup` — no `device.gateway` parse / gateway key invention.
4. **PUSH/PULL stay separate modules** (no registry yet). Callers choose; Unit 6 wires
  `deliveryPattern`. No admission / `bottleneckKey` / distribute here (D1/D3).

**Checks:** `pnpm typecheck` / `lint` / `test` / `build`.

**Next:** Phase 1 Unit 4 (lifecycle) after review.

### 2026-07-29 — session 8b: lock D5 (stage timeouts → plugin tuning)

**Locked — D5.** Unit 3’s placement of `nsInFlightTimeoutMs`, `gwInFlightTimeoutMs`,
`deviceInFlightTimeoutMs`, and `initialPollDelayMs` on shared `delivery.*` is **interim only**.
End state (ADR-002 §5 + nxt-backend ADR-001): those knobs live in **plugin** `tuning`
(defaults in code, config overrides). Shared `delivery` keeps only cross-plugin knobs
(retry / TTL).

**Revisit at:** Units 5–6 (when `queueKey → pluginId` / registry can supply the owning
plugin’s merged tuning to queue moves) and plugin units 7–9 (declare defaults). Then remove
the stage-timeout keys from the core `delivery` schema.

**Do not:** move them in Unit 4, or invent a half-SPI before the registry exists.

**Written:** deferred table D5; ADR-002 status amendment + §5 table; plan Units 3/5/6 notes.

### 2026-07-29 — session 9: Phase 1 Unit 4 (lifecycle)

**Landed:** `src/lib/lifecycle.push.ts`, `src/lib/lifecycle.pull.ts`.

**Deviations / ADR alignment:**

1. **Interim structural minima, not** `*Adapter` **/** `*Handlers`**.**
  `PushIncoming` / `PushOutgoing` / `PullIncoming`; param named `plugin`. Deleted at
   Unit 6 in favour of `DeviceMessagingPlugin` (not grown into a parallel SPI).
2. **PULL takes** `pluginId`**(s).** `pollAwaitingTasksFor(pluginId, plugin)`;
  `getPullTimeouts(now, pluginIds, cleanupOptions?)` — no `PULL_PATTERN_IMPLEMENTATIONS`,
   no registry.
3. **Max age + poll-delay ladder = module defaults.** 48h / age ladder stay in
  `lifecycle.pull.ts` with D5 note; do not grow interim `delivery.*`.
4. **No** `PULL_MAX_CONCURRENT_`* **export.** Legacy constant belonged to distribute
  (ADR-006 concurrency admission) — Units 5–6 / plugin tuning.
5. **Cleanup pass-through only (D2).** Optional `MessageFullCleanupOptions` on
  `getPullTimeouts`; no gateway/concurrency key invention.
6. Log prefix `[DEVICE MESSAGING]` (was `[DEVICE MESSAGES OUTGOING]`).

**Naming follow-up (same session):** `pollPlugin` → `pollAwaitingTasksFor`;
`*Handlers` → singular facet types; `handlers` → `plugin`.

**Checks:** `pnpm typecheck` / `lint` / `test` / `build` green.

**Unit 4 closed.** Next was Phase 1 Unit 5 (engine); a **pre–Unit 5** SPI+registry slice
landed first (session 10). D1/D2/D3/D5 remain deferred — discuss step by step in Unit 5.

### 2026-07-29 — session 10: pre–Unit 5 (minimal plugin SPI + registry)

**Landed:** `src/lib/plugin.interface.ts`, `src/lib/plugin-registry.ts`, plus
`test/unit/lib/plugin-registry.spec.ts`.

**Scope (thin by design):**

- `DeviceMessagingPlugin`: `id`, `deliveryPattern`, `bottleneckKey`, `admission`, nested
`outgoing` / `incoming`, optional `token`
- `Admission` union per ADR-006 (`spacing` | `concurrency` | `custom`) — **declaration
only**; no distribute execution (D3)
- In-memory registry: `createPluginRegistry` + process-wide `pluginRegistry`
(`register` / `get` / `getAll` / `getByDeliveryPattern` / `clear`)
- `GenerateTokenInput` domain stub (HTTP Zod stays Phase 3)

**Explicitly not here:** D1 owner map, D3 admission wiring, D5 timeout move, config-driven
construction, real plugins, command-type validation (Unit 6 polish).

**Unit 6** in the plan is narrowed to SPI polish + config wiring; minimal SPI is done.

**Checks:** `pnpm typecheck` / `lint` / `test` / `build`.

**Next:** Phase 1 Unit 5 (engine) — first deferred item when distribute/enqueue needs it is
**D1**.

### 2026-07-29 — session 11: Unit 5.1 (engine base)

**Landed:** `src/engine/base.ts` — `retryOrFail`, `requeueMessage`, `emitDeliveryEvent`.

**Deviations:**

1. **No in-process** `subscribe` **/** `publish`**.** Replaced by `emitDeliveryEvent` stub.
  Adopter touchpoint is `resultWebhook.url` (ADR-003 §6); full webhook lands Phase 3.
2. `requeueMessage` **uses** `plugin.bottleneckKey` via `plugin_id` from Redis — not
  legacy `queueInitial`. Missing plugin → warn + drop from retry.
3. `retryOrFail` **optional** `concurrencyRateLimitKey` (D2 interim seam; unused until
  admission is wired).

**Review follow-up (same session):**

- `bottleneckKey` input narrowed to `BottleneckKeyInput` (`network_id` + `device` only).
- `requeueMessage` restored to `getMessageRawPropsById` (priority, device, network_id,
plugin_id) — no full-hash deserialize / `createShape` rebuild.

**No deferred decisions in this slice** (D1 not needed — message already carries `pluginId`).

**Checks:** `pnpm typecheck` / `lint` / `test` / `build`.

**Next:** Unit 5.2 (enqueue / cancel / get-by-correlation) after review.

### 2026-07-30 — session 12: I0 docs pivot (walking-skeleton Intermezzo)

**Course correction.** Bottom-up engine port (Unit 5.2+) produced high-quality substrate but
deferred too many contracts (HTTP, config-driven plugins, real E2E). Continual interim seams
and D1–D5 “later” made progress hard to validate. Preferred approach going forward: lock
**exerciseable** API + config + stub plugins, then finish engine against that path.

**Decided:**

- Insert **Phase 1b — Walking skeleton Intermezzo** (slices I1–I4) **before** Unit 5.2+.
- Unit **5.2+ paused** until Intermezzo closes. D1/D2/D3/D5 revisit only **after** I1–I4
(still with locked ADR criteria — do not invent half solutions in the Intermezzo).
- Intermezzo pulls forward a **thin** slice of Phase 3 (enqueue/get Zod + routes) and a
**stub** of Phase 2 (dummy plugins). Full ADR-003 (HMAC webhook, DLQ, OpenAPI, ingress)
and real CALIN/ChirpStack plugins stay on their phases.
- Work continues in **small reviewable chats**; each chunk ends with docs sync + a
**carry-over prompt** for a fresh session (see plan “How to work”).

**I0 (this session):** docs only — no code.

**Next:** **I1** — boot uses config; construct + register stub plugin(s) from `plugins[]`.

### 2026-07-30 — session 13: I1 boot + stub plugins

**Landed:**

- `src/plugins/stub.ts` — shared `createStubPlugin`; bundled `stub-push` (PUSH + spacing,
`queue:stub_network:{id|unassigned}`) and `stub-pull` (PULL + concurrency,
`queue:stub_gateway:{id|unassigned}`). No-op `sendOne` → `stub-ext-id`; PULL
`fetchStatus` → `null`; PUSH `handle` → `null`.
- `src/plugins/register-from-config.ts` — maps known stub ids → factories; unknown id
fails at boot (real plugins stay Phase 2 / Unit 6).
- `main.ts` — after `loadConfig`, clears registry (tsx watch-safe) and registers
`config.plugins[]`.
- `config.example.json` lists both stubs; `config.default.json` stays empty (ADR-002).

**Decided (this chunk):** two stub ids (B), not a single configurable stub.

**Checks:** `pnpm lint` / `typecheck` / `test` / `build` green.

**Next:** **I2** — thin HTTP Zod + routes for enqueue + get-by-correlation.

### 2026-07-30 — session 13b: plugin boot tidy (one-shot registry under `plugins/`)

**Decided:** Collapse empty-then-register into one-shot construction from config; keep all
plugin code under `src/plugins/` (SPI, catalog, registry, per-plugin folders). Dynamic
import of unused plugins deferred until Phase 2 size justifies it.

**Landed:**

- Moved SPI → `src/plugins/plugin.interface.ts`
- `src/plugins/catalog.ts` — id → factory (`stub-push` / `stub-pull`)
- `src/plugins/registry.ts` — `createPluginRegistry(entries)` lookup-only;
`setPluginRegistry` / `getPluginRegistry` (mirrors config store)
- Stubs → `src/plugins/stub/index.ts`
- Dropped `lib/plugin-registry.ts`, `lib/plugin.interface.ts`,
`plugins/register-from-config.ts`, mutable `register` / `clear` happy path
- `main.ts`: `setPluginRegistry(createPluginRegistry(config.plugins))`
- `engine/base.ts` uses `getPluginRegistry()`

**Checks:** `pnpm lint` / `typecheck` / `test` / `build` green.

**Next:** **I2** — thin HTTP (unchanged).

### 2026-07-30 — session 13c: `runtime.ts` boot exports (drop getConfig / getPluginRegistry)

**Decided:** Process boot is `src/runtime.ts` (top-level await): `export const config` and
`export const pluginRegistry`. Call sites import bindings (may use at module top level).
`lib/` must not import `runtime` — helpers take `delivery` (etc.) as arguments.

**Landed:**

- `src/runtime.ts` — `await loadConfig()` + `createPluginRegistry(config.plugins)`
- Removed `config/store.ts` (`getConfig` / `setConfig`); `loadConfig` returns frozen config only
- Removed `setPluginRegistry` / `getPluginRegistry` from `plugins/registry.ts`
- `main.ts` / `engine/base.ts` import from `runtime`
- Queue / retry / lifecycle helpers take `delivery` instead of reading a global
- ADR-002 §4 amended; ADR-004 test notes updated

**Deferred:** pre-run script collapsing URL/CMS → local JSON (ops); in-app `CONFIG_URL`
remains for now.

**Checks:** `pnpm lint` / `typecheck` / `test` / `build` green.

**Next:** **I2** — thin HTTP (unchanged).

### 2026-07-30 — session 14: I2 thin HTTP (enqueue + get)

**Landed:**

- `src/http/` — Zod schemas (`enqueueBodySchema`, path params), Bearer hook
(`DEVICE_MESSAGING_API_KEY`; skip when unset), in-memory `MessageStore`, routes for
`POST /message/enqueue` (201) and `GET /message/:correlationId` (200/404).
- `buildApp({ pluginRegistry, apiKey?, messageStore? })` — deps injected (no `runtime`
import from HTTP); `main.ts` passes boot registry + env key. `/healthz` stays open.
- Plugin enablement: **one** `pluginRegistry.get(pluginId)` in the enqueue handler.
Zod validates shape only (no known-id enum / catalog re-check).
- Missing `correlation_id` on enqueue → generate ULID. Store is one message per
correlation id (last write wins) until I3 Redis.

**Decided (this chunk):** in-memory Map placeholder; auth minimal (Bearer when set).

**Checks:** `pnpm lint` / `typecheck` / `test` / `build` green.

**Next:** **I3** — replace in-memory store with Redis enqueue + get-by-correlation.

### 2026-07-30 — session 14b: command API camelCase + httpYac smoke

**Decided — outward API is fully camelCase.** Zod + responses use `commandType`,
`correlationId`, `networkId`, `externalReference`, etc. Aligns with ADR-003 webhook wire.
Amended ADR-003 §2 (vocabulary vs wire casing).

**Interim map:** `src/http/wire.ts` maps camelCase ↔ snake_case domain. Exists only until
domain + Redis flip; then delete it.

**Redis / domain camelCase (not this chunk — revisit at I3):**

- **No production dual-write obstacle** — company cutover is stop-then-start onto a greenfield
Valkey; no need to read old snake_case hashes in prod.
- **Real cost:** atomic rename across `lib/types.ts`, redis-repository serialize/deserialize,
Lua (if any field names), index key prefix `idx:correlation_id:` (optional cosmetic), and
all call sites already ported in Units 1–5.1. Do it in **one pass** with I3 (or immediately
before) so enqueue writes camelCase and the HTTP map disappears.
- Estate Postgres `command_type` (ADR-011) is unrelated — stays on `nxt-backend`.

**Landed:** camelCase schemas/routes/tests; `src/http/smoke/` httpYac (`.httpyac.js`,
`healthz.http`, `message.http`, README) — Bearer via `{{$dotenv DEVICE_MESSAGING_API_KEY}}`
(no login `@ref`; enqueue `# @name` for get-by-response). `.env.example` sets
`DEVICE_MESSAGING_API_KEY=dev-key`. ESLint ignores `src/http/smoke/**`.

**Next:** **I3** — Redis enqueue/get; prefer domain+Redis camelCase in that pass if scope
allows, else keep the wire map one more chunk.

### 2026-07-30 — session 14c: httpYac polish; I2 closed

**Landed (smoke only):**

- `.httpyac.js` → `.httpyac.cjs` (package is `"type": "module"`; CJS `module.exports`).
- Dropped `$dotenv` for the API key — multi-root workspaces often miss this repo’s `.env`.
Local `apiKey: 'dev-key'` in `.httpyac.cjs` (mirror `nxt-backend` `devApiKey`); keep in
sync with `DEVICE_MESSAGING_API_KEY` in `.env`.
- Verified: `/healthz` OK; enqueue/get with Bearer succeed against in-memory store.

**I2 closed.** Next chunk is **I3**.

### 2026-07-30 — session 15: I3 enqueue → Redis + domain/Redis camelCase

**Decided:** Flip domain types + Redis hash fields + index prefixes to camelCase in this
pass; delete `src/http/wire.ts`. Greenfield Valkey at cutover — no dual-write. Estate
Postgres `command_type` (ADR-011) stays snake_case on `nxt-backend`.

**Landed:**

- Domain (`src/lib/types.ts`) + serialize/deserialize + Lua HSET field names +
`idx:correlationId:` / `idx:externalDeliveryId:` — all camelCase.
- `BottleneckKeyInput.networkId`; plugin SPI / stubs / queue-moving / lifecycle / engine
base updated.
- Thin `src/engine/outgoing.ts` — enqueue via `plugin.bottleneckKey` + Redis; get-by-
correlation; **no distribute**.
- HTTP routes use injected `Outgoing` (default Redis); deleted in-memory `message-store`
and `wire.ts`. Unit tests inject in-memory outgoing.
- ADR-003 §2 amended; ADR-006 bottleneck examples aligned. Plan / AGENTS synced.

**Checks:** `pnpm lint` / `typecheck` / `test` / `build` green.

**Intermezzo HTTP↔Redis exit criterion met in code.** Smoke against Valkey:
`src/http/smoke/message.http` with Valkey up + `pnpm dev`.

**Next:** **I4** optional (cancel and/or one stub distribute/send tick), or **close
Intermezzo** and resume Unit 5.2+ (cancel remainder, then 5.3 distribute + D1/D3).

### 2026-07-30 — session 15b: Redis key vs hash-field casing locked

**Decided — clear divide:**

- **JS domain + Redis hash fields** = camelCase (serialized object properties)
- **Redis key paths + Lua locals** = snake_case; segment separator `:` (not `#`)

Index prefixes reverted to snake_case: `idx:correlation_id:`, `idx:external_delivery_id:`.
Documented on `redisKeys`, ADR-003 §2, AGENTS, plan I3.

### 2026-07-30 — session 15c: I3 polish + close chunk

**Landed (follow-ups on I3):**

- Composition: `buildApp` requires `outgoing` (no Redis factory in `app.ts`); `main` calls
`createOutgoing()` which reads `pluginRegistry` from `runtime` (same as `engine/base`).
- Lean HTTP: plugin enablement in outgoing → `UnknownPluginError` → route maps 400; no
`pluginRegistry` on route opts. Optional `correlationId` only (no server ULID — legacy
parity). No enqueue body remap.
- Create DTO: Zod `createDeviceMessageSchema` is source of truth → `CreateDeviceMessage`;
dropped `EnqueueBody`. Layout: `lib/device-message/schemas.ts` (Zod only) +
`types.ts` (infer + lifecycle); HTTP path params in `http/message-params.ts`.
- Redis casing locked (15b). Smoke test SREMs `queues_to_distribute_from` after cleanup
(distributor Lua GC's that in production; no distribute yet).
- README + AGENTS: Valkey-only compose then `pnpm dev`; status reflects walking skeleton.

**Checks:** lint / typecheck / test / build green; `RUN_REDIS_SMOKE=1` smoke passed.

**I3 closed.** Intermezzo HTTP↔Redis exit criterion met.

**Next:** Maintainer chooses **I4** (optional cancel and/or stub distribute/send tick) **or
close Intermezzo** and resume Unit 5.2+ (cancel remainder → 5.3 distribute + D1/D3).
Generic Zod validation error bodies deferred to Phase 3 / OpenAPI hardening.

### 2026-07-30 — session 16: close Intermezzo + end-to-end working rule

**Decided:**

- **Close Intermezzo.** Skip **I4** (no optional cancel / stub distribute tick in 1b).
- **End-to-end rule after 1b:** each Unit 5 slice with an ADR-003 **command or ingress**
surface ships **thin HTTP + smoke in the same chunk** (same lean style as enqueue/get).
Remap: **5.2** cancel + cancel routes; **5.5** incoming + thin ingress; **5.6** token +
thin `POST /token/generate` (+ timers).
- **Timer-only paths** (distribute / send / poll in 5.3–5.4): no public route. Exercise via
bootable **stub plugins** (`src/plugins/stub/` — real catalog entries, not test-only
fixtures) + enqueue/get; tests may invoke one tick.
- **Debug HTTP** to run distribute/poll once: deferred (nice for manual stepping; overkill
while timers + stubs suffice). Revisit if smoke against timers becomes painful.
- **Phase 3** shrinks to ADR-003 **polish** (webhook HMAC/DLQ, OpenAPI, auth hardening) —
not first landing of cancel/token/ingress routes.

**Docs only** this session — AGENTS, plan 001, this log.

**Next:** Unit **5.2** — cancel from legacy `outgoing.service.ts` + thin
`POST /message/cancel` / `POST /messages/cancel` + httpYac smoke.

### 2026-07-31 — session 17: Unit 5.2 cancel + thin cancel HTTP

**Landed:**

- `src/engine/outgoing.ts` — `cancelOne` / `cancelMany` (legacy semantics): lookup all
messages for correlation id (base + phases); cancel only `QUEUED` / `TO_RETRY`; atomic
ZREM claim then `messageFullCleanup`. Outcomes `CANCELLED` | `NOT_CANCELLABLE` |
`NOT_FOUND`.
- **Adaptation:** `queueInitial` → `plugin.bottleneckKey` via `pluginRegistry` (same as
enqueue / requeue). Missing plugin on `QUEUED` → not cancellable. `TO_RETRY` →
`QUEUE_RETRY_KEY`. No concurrency key on cleanup (D2 interim).
- Thin HTTP: `POST /message/cancel` / `POST /messages/cancel` (Zod bodies in
`lib/device-message/schemas.ts`); **200** + result body for all three outcomes
(including `NOT_FOUND` — business result, not HTTP 404).
- In-memory outgoing + route tests; httpYac smoke extended in `message.http`.

**Checks:** `pnpm lint` / `typecheck` / `test` / `build`.

**Next:** Unit **5.3** — decide D1 with maintainer, then distribute + D3.

### 2026-07-31 — session 17b: 5.2 review follow-ups

**Landed:**

- Lean plugin guards: cancel `if (!plugin) return false`; requeue drops warn (still
removes orphan from retry). Soft `registry.get` kept — call sites need different
missing-plugin policies (enqueue 400 vs cancel NOT_CANCELLABLE vs requeue drop).
- `createOutgoing(registry)` — registry injected (no `runtime` import in outgoing);
composition root passes `pluginRegistry`.
- Restored fuller cancel JSDoc / `@performance` from legacy (adapted to correlationId).
- Opt-in integration smoke: `test/integration/outgoing-cancel.smoke.spec.ts`
(enqueue → cancel → get against real Redis + stub registry).
- Carried finding: thorough cleanup suite wanted (4 enqueue keys + all stage exits).

**Checks:** `pnpm lint` / `typecheck` / `test` / `build`; `RUN_REDIS_SMOKE=1` when Valkey up.

### 2026-07-31 — session 17c: lock factory + closure DI pattern

**Decided:** Preferred composition shape when practical — factory function with injected deps,
locally scoped helpers (closures), returned object literal as the interface. Exemplar:
`createOutgoing(registry)`. Locked in ADR-001 §2 amendment + `AGENTS.md` code conventions.
Not a container; not mandatory for pure helpers / Redis module singleton.

### 2026-07-31 — session 18: Unit 5.3 — D1 = boot-time kind registry (B)

**Decided — D1 option B** (superseded same day by session 18b). Distribute maps
`queueKey → plugin` via a boot-time `bottleneckKind` index.

**Landed then reverted in 18b:** `bottleneckKind` SPI field, `getByBottleneckKind`,
`bottleneckKindFromQueueKey`, stub kinds `stub_network` / `stub_gateway`.

### 2026-07-31 — session 18b: D1 revised — `pluginId` in initial-queue key

**Decided — D1 option C (replaces 18/B).** The initial-queue key embeds `pluginId`;
distribute parses that segment for `registry.get`. No kind registry, no Redis owner map.

**Locked:**

- Key shape: `queue:{pluginId}:{kind}:{id}` via `buildInitialQueueKey(pluginId, kind, id)`
- SPI: `initialQueueKey(input)` (renamed from `bottleneckKey`); input type
`InitialQueueKeyInput`
- `kind` = human label for the admission node; not used for policy
- Parse helper: `getPluginIdFromInitialQueueKey` (no enqueue re-check of the key we just built)
- Hard cutover: legacy `queue:lorawan_network:…` / `queue:gateway:…` not preserved;
V1/V2 get separate per-plugin buckets

**Reverted from session 18:** `bottleneckKind`, `getByBottleneckKind`,
`bottleneck-kind.ts`, kind uniqueness at boot.

**Landed:** helper + SPI + stubs (`queue:stub-push:network:…` /
`queue:stub-pull:gateway:…`) + engine call sites + ADR-006 rewrite of §1/D1 + plan/AGENTS.

**Next:** Unit 5.3 continue — distribute + D3 on outgoing (still stop before
`sendOne` unless maintainer widens scope).

### 2026-08-01 — session 19: Unit 5.3 — distributeToNetworkServers + D3

**Decided:**

- **Composition:** `distributeToNetworkServers` lives on `createOutgoing` (legacy shape),
not a separate `createDistribute` factory. Prior carry-over naming was a process
artifact, not an ADR.
- **Method name:** keep legacy `distributeToNetworkServers` (not shortened `distribute`).
- **Enqueue kick:** restore fire-and-forget call after Redis enqueue (legacy parity);
not a deferred ADR item. Tests that need `QUEUED` to stick use
`kickDistributeOnEnqueue: false`.
- **Cron /** `engine.enabled`**:** still deferred to Unit 5.6; tests invoke one tick.
- `createBase`**:** not this chunk — `emitDeliveryEvent` stays a free export from
`base.ts` for now.

**Landed:**

- `createOutgoing({ registry, delivery, kickDistributeOnEnqueue? })` — admit
(spacing / concurrency / custom) → `pickNextAndMoveToNs` → concurrency/`onClaim` →
`emitDeliveryEvent` if `!retryCount`. **Stops before** `sendOne`**.**
- Opt-in smoke: `test/integration/outgoing-distribute.smoke.spec.ts`.
- Docs: ADR-006 D3; plan Unit 5.3; AGENTS; ADR-001 factory example.

**Review polish (same session):** factory-local helpers `_`-prefixed; `switch` on admission
strategy; lean skip on bad queueKey / missing plugin; method-scoped log tags; drop
“legacy” / `[DEVICE MESSAGING]` wording in outgoing. Concurrency Redis key: no SPI
`rateLimitKey` — `buildConcurrencyRateLimitKey(queueKey)` in `initial-queue-key.ts`
(`queue:…` → `rate_limit:…`); cleanup/repo option stays `concurrencyRateLimitKey`.

**Next:** Unit **5.4** — `sendOne` + post-send PUSH|PULL queue moves
(message → `initialQueueKey` → `buildConcurrencyRateLimitKey` for retry/cleanup when
admission is concurrency; prefer `createBase` when touching `base.ts`).

### 2026-08-02 — session 20: Unit 5.4 — sendOne + post-send moves

**Decided:**

- **Fire-and-forget** `sendOne`**:** legacy parity — distribute tick completes at handoff;
outer `.catch` kept (inner try/catch only covers plugin `sendOne`; moves/`retryOrFail`
can still reject).
- **Peer factories at composition root:** `createBase` and `createOutgoing` are siblings
wired in `main.ts` (and tests). Outgoing does **not** construct base internally —
incoming (and later peers) will share the same `base` instance.
- `emitDeliveryEvent`**:** remains a free export from `base.ts` (webhook later).

**Landed:**

- `createBase({ registry, delivery })` — `retryOrFail` / `requeueMessage`; dropped
`runtime` import.
- `createOutgoing({ registry, delivery, base, kickDistributeOnEnqueue? })` — after pick /
claim / emit, fire-and-forget `_sendOneToNetworkServer`:
  - success + delivery id → PULL `fromNsToAwaitingTask` / PUSH `fromNsToGw`
  - failure → `base.retryOrFail` from `QUEUE_NS_KEY` with
  `_concurrencyRateLimitKeyFor` when `admission.strategy === 'concurrency'`
- Opt-in smoke updated: enqueue → distribute → poll `DELIVERED_TO_NS` (GW vs
awaiting-task).
- Docs: plan Unit 5.4; AGENTS.

**Next:** Unit **5.5** — incoming + thin `POST /ingress/:pluginId` + smoke.

### 2026-08-03 — session 21: Unit 5.5 — incoming + thin ingress + poll

**Decided:**

- **Peer** `createIncoming` **shares** `base` from the composition root (same instance as
outgoing) — no internal `createBase`.
- **HTTP resolves the plugin once** (enablement, PUSH `handle`, optional
`verifySignature`); `incoming.handle(event, plugin)` does not re-look up.
- **Poll method rename:** legacy `pollPullImplementations` → `pollPullPlugins`
(registry / SPI vocabulary). Callable tick only; cron stays 5.6.
- **Step order:** A = `handle` + thin ingress + PUSH smoke; B = `pollPullPlugins` +
PULL smoke (separate review).

**Landed:**

- `createIncoming({ registry, delivery, base })` — shared `_processIncomingEvent`
(unsolicited / GW ACK / fail / success → `emitDeliveryEvent`); `handle`;
`pollPullPlugins` via `pollAwaitingTasksFor`.
- Thin `POST /ingress/:pluginId` — no Bearer; raw JSON buffer; signature → 401;
unknown / non-PUSH → 400; accept → 204.
- Stub PUSH `handle` accepts a pre-normalized `ParsedIncomingEvent` body.
- Smokes: `incoming-ingress.smoke.spec.ts`, `incoming-poll.smoke.spec.ts`.
- Docs: plan Unit 5.5; AGENTS.

**Next:** Unit **5.6** — token + thin `POST /token/generate` + interval timers
(`engine.enabled`).

### 2026-08-03 — session 22: Unit 5.6 — token + timers; `*Service` naming

**Decided:**

- **Step order:** A = token + thin HTTP + smoke; B = resolution cycle + timers;
then naming/optional-`buildApp` cleanup before docs.
- **Token wire:** body = SPI `GenerateTokenInput` + `pluginId`; response `{ token }`;
`stub-push` exposes `token.generate` → `'stub-token'`.
- **Errors:** throwables only from `src/engine/errors.ts` (no service re-exports).
Command routes: service owns enablement. Ingress keeps HTTP resolve (signature).
- **Facade naming:** `BaseService` / `OutgoingService` / `IncomingService` /
`TokenService` + matching `create*Service` factories; composition locals
`baseService` / `outgoingService` / …
- `buildApp` **deps optional:** register route plugins only when deps present;
`buildApp()` enough for `/healthz`; tests inject only what they exercise.
- **Timers:** plain `setInterval`, gated on `engine.enabled`; no overlap guard;
`stop()` returned for tests/shutdown. Interval defaults on options destructuring.
- **GW extend:** assume plugin present (`registry.get(pluginId)!`) when message hash
exists; keep orphan-message guard only.
- **Comments:** drop Nest/legacy provenance from engine docs where it does not
document an open decision.

**Landed:**

- `createTokenService` + thin `POST /token/generate` + Zod + smokes / httpYac.
- `OutgoingService.runMessageResolutionCycle` + `startEngineTimers` in `main.ts`.
- Opt-in `outgoing-resolution.smoke.spec.ts`; unit `timers.spec.ts`.
- Docs: plan Unit 5 complete; import ledger token/outgoing/DTOs; AGENTS.

**Next:** Unit **6** — plugin SPI polish + config wiring (command-type validation;
D5 stage timeouts → plugin `tuning`).

### 2026-08-04 — session 23: Unit 6.1 vocabulary; defer wire parent-node naming (D6)

**Unit 6.1 (landed earlier this session / prior turns):** service-owned `CommandType` /
`ENQUEUEABLE_COMMAND_TYPES` / `GENERATE_TOKEN_TYPES` (`TOP_UP_KWH`); plugin
`supportedCommandTypes`; token body Zod-inferred; Unit 4 interim lifecycle facets
deleted; PUSH/PULL discriminant / boot-assert **skipped** (does not remove downstream
checks). ADR-003 §4 amended.

**D6 — wire** `device` **parent node (documented, not decided):**

Legacy packed both LoRaWAN gateway and CALIN DCU into `device.gateway`. Admission
`kind` in queue keys is already plugin-local (D4). The remaining smell is the **shared
create/webhook field name**.

Options to revisit before Units 7–9:


| Option | Idea                                                        | Trade-off                                                                                                 |
| ------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| A      | Keep `device.gateway`; plugins interpret as DCU when needed | Simple; wrong name for CALIN adopters                                                                     |
| B      | Dual optional `gateway` + `dcu` on the wire                 | Honest names; core schema knows both; plugins must pick; webhook noisier                                  |
| C      | One generic field (e.g. `accessNode` / `relay`)             | Core topology-agnostic; docs map gateway/DCU; LoRaWAN-only `snr`/`rssi` still awkward on a generic object |
| D      | Opaque plugin-shaped device extras                          | Maximum flexibility; weak shared validation / OpenAPI                                                     |


**Finding:** business reads of parent id already belong in plugins (`initialQueueKey`).
Core today only *declares* the Zod shape — it does not branch on `gateway` for
admission. So “checks inside plugins only” is already true for routing; what remains
is whether the **wire vocabulary** stays gateway-flavoured. Dual fields are possible
but tedious (two slots, mutual exclusivity, ingress normalisation). A single generic
name is the usual fix if we rename at all.

**Not in this note:** D5 stage-timeout *SPI names* (still open when locking 6.2 shape —
avoid baking `gw*` into plugin `tuning` if we rename).

**Next:** lock 6.2 `tuning` shape + names, then implement D5.

### 2026-08-04 — session 23b: lock D5 names + D6 `relayNode` (implement stepwise)

**Locked — D6:** wire field `device.relayNode` (replaces `device.gateway`). Generic I/O
parent for LoRaWAN gateway, CALIN DCU, or mesh hop. Core still does not branch on it for
admission (D4 `kind` remains plugin-local and may say `dcu` / `gateway` / `relayNode`).

**Locked — D5 tuning + PUSH mid-stage Redis (one vocabulary):**


| Tuning (`plugin.tuning`)     | Scores / meaning                                                |
| ---------------------------- | --------------------------------------------------------------- |
| `nsInFlightTimeoutMs`        | `queue_in_flight_to_ns`                                         |
| `relayNodeInFlightTimeoutMs` | `queue_in_flight_to_relay_node` (was `…_to_gw` / `gwInFlight*`) |
| `deviceInFlightTimeoutMs`    | `queue_in_flight_to_device` (end meter)                         |
| `initialPollDelayMs`         | first PULL poll                                                 |


Shared `delivery` keeps only retry knobs + `messageTtlSeconds`. Helpers rename with the
key (`fromNsToRelayNode`, `QUEUE_RELAY_NODE_KEY`, …). Rejected for the mid stage:
`downlink*` (third vocabulary) and keeping `gw*` on the SPI.

**Implement Unit 6.2 in small reviewable steps:**


| Step  | Scope                                                      |
| ----- | ---------------------------------------------------------- |
| **A** | Docs lock (this note + ADR-002/003)                        |
| **B** | Wire `gateway` → `relayNode`                               |
| **C** | Redis/helpers `gw` → `relay_node`                          |
| **D** | `plugin.tuning` on SPI + stub defaults                     |
| **E** | Queue-moving reads tuning; drop stage keys from `delivery` |
| **F** | Stub factories merge config `tuning`                       |
| **G** | Plan / AGENTS close-out                                    |


**Next:** Step **B** after maintainer accepts Step A.

### 2026-08-04 — session 23c: Unit 6 closed (6.1 + 6.2 A–G)

**Landed (Unit 6.1 — earlier this session):** command vocabulary + plugin
`supportedCommandTypes`; `TOP_UP_KWH`; token Zod-inferred types; lifecycle facets deleted;
PUSH/PULL tighten skipped.

**Landed (Unit 6.2 steps A–G):**


| Step | Result                                                                                               |
| ---- | ---------------------------------------------------------------------------------------------------- |
| A    | Docs lock D5/D6                                                                                      |
| B    | Wire `device.relayNode`; stub PULL `kind` = `relayNode`                                              |
| C    | Redis/helpers `queue_in_flight_to_relay_node` + API renames; config key `relayNodeInFlightTimeoutMs` |
| D    | `PluginTuning` on SPI + `STUB_DEFAULT_TUNING`                                                        |
| E    | Queue-moving / engine read `plugin.tuning`; stage keys dropped from `delivery`                       |
| F    | `mergeStubTuning` + example config override                                                          |
| G    | Plan / AGENTS / this close-out                                                                       |


**D5 + D6 closed.** Catalog still stubs-only (real factories = Units 7–10). D4 remains for
plugin-local admission `kind` strings. D2 / thorough cleanup suite unchanged.

**Next:** Phase 2 **Unit 7** — `calin-api-v1` plugin (order amended sessions 24 / 24b).

### 2026-08-04 — session 24: Phase 2 order — V1 before ChirpStack

**Amendment:** Unit **7** = `calin-api-v1` (PULL; controllable vendor API for testing);
ChirpStack deferred. No code change.

### 2026-08-04 — session 24b: `nxt-sts` before ChirpStack

**Amendment:** final Phase 2 order:


| Unit   | Plugin             | Why                                                  |
| ------ | ------------------ | ---------------------------------------------------- |
| **7**  | `calin-api-v1`     | Controllable PULL testing; first real SPI validation |
| **8**  | `nxt-sts`          | Token generate needed to exercise token commands     |
| **9**  | `calin-chirpstack` | PUSH; harder to drive externally                     |
| **10** | `calin-api-v2`     | Second HTTP CALIN variant                            |


Import ledger unit numbers updated. No code change.

**Next:** Phase 2 **Unit 7** — `calin-api-v1` from `legacy/.../adapters/calin-api-v1/`
at baseline `db5c2ac`.

### 2026-08-04 — review nits pass (carried)

**Open — PULL** `deliveryQueueId` **/** retry **race (engine, not plugin-specific).**
`fromAnyToRetry` clears `deliveryQueueId`, drops the external-delivery index, and ZADDs
`queue_awaiting_retry` in one pipeline. A concurrent poll can already hold `messageId`
(lookup succeeded) and later call `messageFullCleanup`, which does **not** ZREM
`queue_awaiting_retry` — leaving an orphan retry member after the hash is deleted.
(Poll holding a stale in-memory `deliveryQueueId` for `fetchStatus` is a milder sibling;
skip-if-missing on re-read is already guarded.) Not fixed here. Preferred fix: serialize
poll vs retry, or claim/remove retry membership in success cleanup (D2 family). **Do not**
gate enabling `calin-api-v1` alone — same hole exists for any PULL plugin (incl. stubs);
plugin stays opt-in via `plugins[]`. Thorough cleanup exit-path matrix still deferred.

### 2026-08-05 — session 25: Unit 7 closed (`calin-api-v1`)

**Phase 2 Unit 7 done** (7.0–7.6). First real PULL adapter on the SPI.

**Landed slices:**

| Step | Scope |
|---|---|
| 7.0 / 7.1 | Scaffold: factory, secrets (`CALIN_API_V1_*`), catalog, admission concurrency 5, `kind`=`dcu`, tuning defaults; `_shared/` (`initial-queue-key`, `merge-plugin-tuning`); SPI optional `getRemoteStatus` |
| 7.2 | `lib/repo.ts` — `createCalinApiV1Client` via native `fetch`; `CalinApiV1Error`; `toSafeNumberOrNull` in `_shared/` |
| 7.3 | `outgoing.ts` — COMM create-task (read/control/write/token delivery) |
| 7.4 | `incoming.ts` — poll task status; **camelCase** `response.data` |
| 7.5 | `token.ts` — POS / maintenance mint; wire `TOP_UP_KWH`; `generateTokenSchema` type-discriminated |
| 7.6 | This ritual (plan / AGENTS / ledger / log) |

**Locks (do not re-litigate without maintainer):**

- Env prefix **`CALIN_API_V1_*`** (URL = `CALIN_API_V1_URL`); not legacy `CALIN_V1_*`
- HTTP: native **`fetch`** (no axios/ky; revisit ky at Unit 10 if needed)
- `response.data` keys: **camelCase** (deliberate vs legacy snake_case)
- Token wire: **`TOP_UP_KWH`**; schema requires `payload.kwh` / `payload.powerLimit` per type
- Admission: `{ strategy: 'concurrency', maxInFlight: 5 }`; D4 `kind` = **`dcu`**
- `config.example.json` stays stubs-only so `pnpm dev` works; enable v1 via `plugins[]` + env
- Factory: `createCalinApiV1Plugin(entry)` only — secrets from `process.env` (`vi.stubEnv` in tests)

**Still open (unchanged):** D2 / thorough cleanup suite; PULL poll↔retry orphan race
(review nits, clarified above); `generateRandomNumber` deferred to Unit 8 with `nxt-sts`.

**Next:** Phase 2 **Unit 8** — `nxt-sts` from `legacy/.../adapters/nxt-sts/_token.service.ts`
(`HttpService` → `fetch`; map wire `TOP_UP_KWH` ↔ vendor `TOP_UP` if the STS API still expects
the estate name).

### 2026-08-05 — review: fetch timeout vs `NS_SLOW` (Unit 7 follow-up)

**Context.** Reviewer asked for `AbortSignal` on `calin-api-v1` `fetch` so a hung CALIN
socket cannot pin all five concurrency admission slots. Stage timeouts do not cancel the
in-flight HTTP call.

**Locked for now — no request abort on the CALIN client.**

- Legacy V1 axios also had **no** request timeout; production often waited a long time and
  still got a response.
- Aborting at ~`nsInFlightTimeoutMs` (20s default) would fight that: slow success is common,
  and legacy already warned that resolution may have zombie-retried the NS entry meanwhile.
- Observability first: ported legacy **`[NS_SLOW]`** logging into engine
  `_sendOneToNetworkServer` — warn when `sendOne` exceeds `plugin.tuning.nsInFlightTimeoutMs`
  (throw path and success path). Threshold tracks tuning, not a hardcoded 20s.

**Deferred improvements (real, not “abort at 20s”):**

| Item | Why it matters | When |
| --- | --- | --- |
| Generous fetch safety deadline (e.g. 60–120s) + optional `err.name === 'TimeoutError'` branch in the client | Caps true never-return hangs without cutting normal slow CALIN | If real hangs show up in testing / ops |
| NS zombie `retryOrFail` should pass `concurrencyRateLimitKey` when the plugin uses concurrency admission | Today a hang past NS timeout can leave the admission slot occupied while the message is retried; `validateAndCleanConcurrencyRateLimit` only drops members whose message hash is gone | Engine / D2 family — next time we touch NS timeout or admission release |
| (Depends on abort) map `TimeoutError` distinctly from generic “API is down” in `repo.ts` | Clearer failure history if/when AbortSignal lands | With the safety deadline |

Do **not** treat short AbortSignal as a Unit 7 must-fix. `NS_SLOW` is the intentional
stand-in until field evidence says otherwise.

### 2026-08-05 — session 26: Unit 8 closed (`nxt-sts`)

**Phase 2 Unit 8 done.** Token-only STS generator plugin on the SPI.

**Landed slices:**

| Step | Scope |
|---|---|
| 8.1 | Scaffold: factory, secrets (`NXT_STS_URL`), catalog, token-only SPI placeholders, `.env.example` |
| 8.1a | Shared `requireEnvKeys` in `_shared/`; migrate v1 + nxt-sts secrets loaders |
| 8.2 | `generateRandomNumber` in `_shared/`; `lib/repo.ts` native `fetch`; `token.ts` mint + `TOP_UP_KWH` → vendor `TOP_UP`; require `device.decoderKey`; unit tests |
| 8.3 | This ritual (plan / AGENTS / ledger / log / ADR-002 env row) |

**Locks (do not re-litigate without maintainer):**

- Env: **`NXT_STS_URL`** (not legacy `STS_GENERATOR_API`)
- HTTP: native **`fetch`** (same Unit 7 lock)
- Wire `TOP_UP_KWH` → STS body `type: 'TOP_UP'`; other generate types pass through
- `device.decoderKey` required at plugin (optional on wire schema)
- Token-only SPI placeholders kept (empty `supportedCommandTypes`, throw `sendOne`, unused
  tuning/admission/`queue:nxt-sts:none:na`) — SPI amend for real omission deferred
- `config.example.json` stays stubs-only; enable via `plugins[]` + `NXT_STS_URL`
- Failures throw **`NxtStsError`** (missing decoderKey, empty token, transport)

**Still open (unchanged):** D2 / thorough cleanup suite; PULL poll↔retry orphan race;
token-only SPI discriminant (optional follow-up); Unit 7 fetch-abort / NS zombie notes.

**Next:** amended session 26b — Unit 9 is `calin-api-v2` (not ChirpStack).

### 2026-08-05 — session 26b: `calin-api-v2` before ChirpStack

**Amendment:** final Phase 2 order:


| Unit   | Plugin             | Why                                                  |
| ------ | ------------------ | ---------------------------------------------------- |
| **7**  | `calin-api-v1`     | Controllable PULL testing; first real SPI validation |
| **8**  | `nxt-sts`          | Token generate needed to exercise token commands     |
| **9**  | `calin-api-v2`     | Second HTTP CALIN variant; easier after v1           |
| **10** | `calin-chirpstack` | PUSH; harder to drive externally                     |


Import ledger unit numbers updated. No code change.

**Next:** Phase 2 **Unit 9** — `calin-api-v2` from `legacy/.../adapters/calin-api-v2/`
at baseline `db5c2ac`.

### 2026-08-06 — session: `nxt-sts` posts `TOP_UP_KWH` through (Step A)

**Supersedes** session 26 lock “Wire `TOP_UP_KWH` → STS body `type: 'TOP_UP'`”.

`nxt-sts` now accepts canonical wire `TOP_UP_KWH` (deprecated alias `TOP_UP` remains on
that service for older callers). The messaging plugin drops `toVendorTokenType` and posts
`type` through unchanged. `NxtStsTokenRequest['type']` includes `TOP_UP_KWH`.

**Still open (plugin call-path follow-ups, discuss one at a time):** `issueDate` interop,
`decoderKey` shape, error/logging hygiene, optional fetch timeout / RND range.

**Next:** Unit 9 when ready; or continue nxt-sts plugin hardening steps after review.

### 2026-08-06 — session: `nxt-sts` call-path closed; deferred sanitization

**STS ↔ messaging interop (done this session):**

| Step | Scope |
|---|---|
| A | Post `TOP_UP_KWH` through (no vendor map) |
| B | Reject non-ISO-datetime `issueDateString` in plugin before fetch |
| C | Require `device.decoderKey` = 16 hex chars in plugin before fetch |
| RND | `STS_RANDOM_NUMBER_MAX` 12 → 16 (full STS 4-bit field 0..15) |

**Supersedes** the “Still open” list on the Step A note above for those items.

**Deferred — later nxt-device-messaging sanitization pass** (not STS vocabulary /
interop; do not block Unit 9):

| Item | Where / notes |
|---|---|
| Redact secrets in client error logs (`decoderKey`, etc.) | `plugins/nxt-sts/lib/repo.ts`; audit CALIN clients if they log request bodies |
| Map plugin/vendor token errors to useful HTTP statuses | `http/token-routes.ts` (+ shared pattern for other plugins); prefer a dedicated HTTP/API chunk |
| Fetch timeout (`AbortSignal`) | `nxt-sts` client; see also Unit 7 CALIN fetch-abort notes |
| Trailing-slash base URL normalize | Plugin HTTP clients (`NXT_STS_URL`, CALIN URLs) |

Token-only SPI placeholders remain deferred as already locked in session 26.

**Next:** Phase 2 **Unit 9** (`calin-api-v2`) when ready.

### 2026-08-06 — session 27: Unit 9 closed (`calin-api-v2`)

**Phase 2 Unit 9 done** (9.1–9.6). Second HTTP CALIN PULL adapter on the SPI.

**Landed slices:**

| Step | Scope |
|---|---|
| 9.1 | Scaffold: factory, secrets (`CALIN_API_V2_*`), catalog, admission concurrency 5, `kind`=`dcu`, tuning defaults, `.env.example`; unknown-id tests → `calin-chirpstack` |
| 9.2 | `lib/repo.ts` — `createCalinApiV2Client` via native `fetch` + login Bearer cache; JWT `exp` via base64url (no `jsonwebtoken`); login-only `AbortSignal.timeout(5s)` |
| 9.3 | `outgoing.ts` — create-task (read/control/write/token delivery); blank-token guard; calendar date validation; V2 date format `YYYY-MM-DD 00:00:00` |
| 9.4 | `incoming.ts` — Get*Task poll; status 0/1/2/3; **camelCase** `response.data` |
| 9.5 | `token.ts` — mint; wire `TOP_UP_KWH`; `crypto.randomUUID()` for `serialNumber` |
| 9.6 | This ritual (plan / AGENTS / ledger / log / ADR-002 env row) |

**Locks (do not re-litigate without maintainer):**

- Env prefix **`CALIN_API_V2_*`**: `CALIN_API_V2_URL` (was `CALIN_V2_API`),
  `CALIN_API_V2_ADMIN_PASSWORD` (was `CALIN_V2_PASSWORD`); not legacy `CALIN_V2_*`
- HTTP: native **`fetch`** (same Unit 7 lock); no `jsonwebtoken` / `uuid` deps
- `response.data` keys: **camelCase** (same Unit 7 lock)
- Token wire: **`TOP_UP_KWH`**
- Admission: `{ strategy: 'concurrency', maxInFlight: 5 }`; D4 `kind` = **`dcu`**;
  enqueue requires `device.relayNode.id`
- `config.example.json` stays stubs-only; enable via `plugins[]` + `CALIN_API_V2_*`
- Factory: `createCalinApiV2Plugin(entry)` only — secrets from `process.env` (`vi.stubEnv`)
- Login timeout 5s only; general API calls uncapped (Unit 7 NS_SLOW stance)
- `meter-installs` coupling on v2 repo remains **out of scope** (plan coupling note)

**Still open (unchanged):** D2 / thorough cleanup suite; PULL poll↔retry orphan race;
token-only SPI discriminant; Unit 7 fetch-abort / NS zombie notes; nxt-sts sanitization
pass (redact logs, HTTP status mapping, fetch timeout, trailing-slash URL).

**Next:** Phase 2 **Unit 10** — `calin-chirpstack` from `legacy/.../adapters/calin-lorawan/`
at baseline `db5c2ac` (plugin id/folder `calin-chirpstack` per ADR-003 §3).

### 2026-08-07 — session 28: Unit 9 / v1 polish closed

Post–Unit 9 review follow-ups on `calin-api-v2`, then the agreed carry-overs onto
`calin-api-v1`. No new port unit; Phase 2 still next = Unit 10.

**Landed (v2):**

- Widened vendor `code` / `reason` types beyond success literals
- Fixed dead login-failure warning; create-task skips idempotency retries
- Loop B: fail fast on post-refresh 401 with a distinct error
- `Object.hasOwn` in command guards; extracted `_createTask` in outgoing
- Login single-flight; skew / relay coverage nits
- Permanent failures via `CalinApiV2Error({ skipRetry: true })` (one error type)

**Landed (v1 carry-over):**

- `Object.hasOwn` in command guards
- Widened vendor response types
- Extracted `_createCommTask` in outgoing
- `CalinApiV1Error` options bag `{ code?, skipRetry? }`; permanent local failures
  (missing/blank token, missing write payload, invalid `SET_DATE`, unimplemented
  parser / `Not implemented`) set `skipRetry: true`; `parseError` uses
  `err.skipRetry || err.code === 99`

**Also:** `config.testing.json` slimmed to plugin ids only
(`calin-api-v1`, `calin-api-v2`, `nxt-sts`).

**Locks (do not re-litigate without maintainer):**

- Plugin vendor errors use an options bag with optional `skipRetry` for permanent
  local failures; v1 still maps vendor ResultCode `99` → skip-retry in `parseError`
- Unit 9 locks from session 27 unchanged

**Still open (unchanged):** D2 / thorough cleanup suite; PULL poll↔retry orphan race;
token-only SPI discriminant; Unit 7 fetch-abort / NS zombie notes; nxt-sts sanitization
pass; `meter-installs` coupling (plan note).

**Next:** Phase 2 **Unit 10** — `calin-chirpstack` from `legacy/.../adapters/calin-lorawan/`
at baseline `db5c2ac` (plugin id/folder `calin-chirpstack` per ADR-003 §3).

### 2026-08-08 — session 29: Unit 10 closed (`calin-chirpstack`)

**Phase 2 Unit 10 done** (10.1–10.6). Last Phase 2 adapter — PUSH CALIN framing over
ChirpStack (legacy folder `adapters/calin-lorawan/`).

**Landed slices:**

| Step | Scope |
|---|---|
| 10.1 | Scaffold: factory, catalog, PUSH + spacing `2_000`, D4 `kind`=`network`, `networkId ?? 'unassigned'`, no token / no `validateEnqueue`; secrets loader under `_shared/chirpstack-repository/` |
| 10.2 | Shared gRPC client `src/plugins/_shared/chirpstack-repository/` (`CHIRPSTACK_*`, `@chirpstack/chirpstack-api` + `@grpc/grpc-js`); camelCase `deliveryQueueId` / `isNewRegistration`; `pnpm-workspace.yaml` `allowBuilds.protobufjs` |
| 10.3 | Plugin `lib/`: types, encode, decode, correlator, connectivity → `relayNode` |
| 10.4 | `outgoing.ts` — encode + enqueue + `getRemoteStatus` + `parseError`; `CalinChirpstackError({ skipRetry })` for encode fail; FK unregistered-device → `skipRetry` |
| 10.5 | `incoming.ts` — tx-ack / ack / join / up + correlator; smoke `POST /ingress/calin-chirpstack` |
| 10.6 | This ritual (plan / AGENTS / ledger / log / ADR-002 env row); D4 closed |

**Locks (do not re-litigate without maintainer):**

- Plugin id/folder **`calin-chirpstack`** (not `calin-lorawan`)
- ChirpStack client lives in **`src/plugins/_shared/chirpstack-repository/`** (plugin-tier
  shared; not `src/lib/`); env stays vendor-scoped **`CHIRPSTACK_*`** (not
  `CALIN_CHIRPSTACK_*`)
- Secrets load inside `createChirpstackClient()`, not in the manufacturer plugin factory
  before the client exists
- Admission: `{ strategy: 'spacing', minIntervalMs: 2_000 }`; D4 `kind` = **`network`**;
  `initialQueueKey` uses `networkId ?? 'unassigned'`
- HTTP to ChirpStack is **gRPC** (not `fetch`); Unit 7 ky revisit remains N/A
- `response.data` / domain fields: **camelCase** (same Units 7/9 lock)
- `config.example.json` stays stubs-only; enable via `plugins[]` + `CHIRPSTACK_*`
- `meter-installs` coupling on chirpstack-repository remains **out of scope** (plan note)
- In-memory correlator: 10s TTL / 30s GC (legacy); process-local, not multi-instance

**Still open (unchanged):** D2 / thorough cleanup suite; PULL poll↔retry orphan race;
token-only SPI discriminant; Unit 7 fetch-abort / NS zombie notes; nxt-sts sanitization
pass; `meter-installs` coupling (plan note).

**Next:** **Phase 3** — ADR-003 polish (webhook HMAC/DLQ, OpenAPI, auth hardening).
Command/ingress/token routes already thin-landed earlier.

### 2026-08-08 — session 30: Unit 10 review follow-ups + ChirpStack `?event=` note

**Landed (review hardenings, not behavior rewrites):**

- ChirpStack unary RPCs: shared `UNARY_RPC_DEADLINE_MS = 60_000` via fresh `CallOptions`
- `registerDevice`: keep swallow-all → `isNewRegistration: false`; richer log
  (`devEui` / `code` / `details`) until `ALREADY_EXISTS` is observed in the wild
- Incoming DevEUI → meter ref: `DEV_EUI_LENGTH` / `METER_REFERENCE_OFFSET = 5`
  (11-digit serials); reject non-16; test uses literal `47003333771`

**Deferred — ChirpStack ingress `?event=` routing (see Carried findings):**

ChirpStack HTTP integration is documented to POST with `?event=`. Maintainer had not
seen this in practice; will observe on the deployed tiamat instance. Until confirmed +
SPI/meta is threaded, `calin-chirpstack` keeps body-heuristic classification. Revisit
with Phase 3 ingress polish or sooner once ops logs show `event`.

**Accepted — ADR-007 (single-replica / single-writer v1):**

Review asked for Redis-backed LoRaWAN correlator for multi-instance ingress. Deferred
per `nxt-backend` ADR-010 §6; recorded in-repo as **ADR-007** (constraint + triggers,
no HA design). Plan Deferred row and correlator fileoverview point at it. Multi-replica
work waits on ADR-007 triggers (operator needs >1 replica, etc.).

**Next:** continue Unit 10 review comments / Phase 3 when prompted.

### 2026-08-08 — session 31: ChirpStack `?event=` routing landed

**Ops confirmation:** deployed tiamat logged
`[CHIRPSTACK INGRESS] query { event: 'up' }` (also `status` / `log`). Full ChirpStack
set: `up` / `join` / `ack` / `txack` / `status` / `log` / `location` / `integration`.

**Landed:**

- SPI: `IncomingHandleMeta` + `handle(event, meta?)`; engine forwards; ingress flattens
  query into `{ query }`
- `calin-chirpstack`: switch on `meta.query.event` — handle `txack` / `ack` / `join` /
  `up`; missing or other events → `null` (fail closed; no body-heuristic fallback)
- Smoke: `POST /ingress/calin-chirpstack?event=txack`
- Carried finding closed

**Locks:** rely on ChirpStack always sending `?event=`; do not fall back to body shape.
Documented in **ADR-003** §5 (`calin-chirpstack` — required `?event=`, fail closed).

**Skipped (review follow-up):** dedicated Prometheus counter + alert for missing `event` —
no `/metrics` / `prom-client` surface yet (ADR-005 Phase 4). Revisit with Phase 4 metrics;
HTTP 204 + null `handle` behavior stays.

**Next:** Phase 3 when prompted / remaining review nits if any.

### 2026-08-10 — session 32: Phase 3.1A — event webhook shape locked

**Docs + config-key rename only** (no delivery implementation).

**Locked:**

| Topic | Decision |
|---|---|
| Config key | **`eventWebhook`** (rename from `resultWebhook` — events, not terminal-only) |
| Module | `src/engine/webhook/` |
| Seam | `baseService.emitDeliveryEvent` → thin forward into `createWebhookService` |
| Envelope | ADR-003 wrap: `eventId` / `occurredAt` / `pluginId` / trimmed `message` |
| Ids | `message.id` ≠ `correlationId` ≠ `eventId` (notification; reused on HTTP retries) |
| Redis | `webhook:pending` (ZSET) / `webhook:payload:{eventId}` / `webhook:dlq:{eventId}` (TTL) |
| Schedule | Always enqueue Redis first; fire-and-forget same private drain as timer (`storeAndEmit` kick); timer = safety net |
| Retry | `maxAttempts: 6`, `baseDelayMs: 2000`, ×2, `maxDelayMs: 60000` (~62s first→last); retry 5xx/429/408/network; no retry other 4xx |
| DLQ | `deadLetterTtlSeconds: 604800` (7d); same Redis DB |
| HMAC | **Deferred (H1)** — unsigned delivery first; opt-in HMAC as separate later chunk |
| Security floor until HMAC | VPC + inbound API key; unsigned outbound POSTs |

**Landed:** ADR-002/003 amendments; plan Phase 3 slices 3.1A–E / 3.2 / 3.3; AGENTS;
schema + `config.example.json` key rename; README.

**Next:** **3.1B** — `eventWebhook` tuning fields with defaults + Redis `webhook:*` helpers /
payload store (no HTTP POST yet).

### 2026-08-10 — session 33: Phase 3.1B — eventWebhook tuning + Redis store

**Landed:**

- Config: `eventWebhook` knobs with Zod defaults (`maxAttempts` 6, `baseDelayMs` 2000,
  ×2, `maxDelayMs` 60s, `deadLetterTtlSeconds` 7d); `EventWebhookConfig` export;
  `config.example.json` + ADR-002 example updated
- `src/engine/webhook/`:
  - `keys.ts` — `webhook:pending` / `payload:{id}` / `dlq:{id}`
  - `types.ts` — `WebhookEvent` + `WebhookStoredRecord` (`event` field; renamed from
    Envelope in review)
  - `backoff.ts` — exponential delay, **no jitter** (predictable ~62s window)
  - `store.ts` — `createWebhookStore({ client })`: enqueue / listDue / get /
    reschedule / complete / deadLetter (MULTI/EXEC); no HTTP
- Unit tests: keys, backoff ladder, parse record, config defaults

**Still stub:** `emitDeliveryEvent` console log; no `createWebhookService` / timer / POST.

**Next:** **3.1C** — `createWebhookService` (build event, enqueue, drain + POST +
retry/DLQ, timer + kick). Wire onto `baseService` in **3.1D**.

### 2026-08-10 — session 34: Phase 3.1C — `createWebhookService`

**Landed:**

- `build-event.ts` — trim partial `DeviceMessage` → `WebhookEvent` (requires
  `pluginId` / `deliveryStatus` / `device`; strips `concurrencyRateLimitKey`)
- `service.ts` — `createWebhookService({ config, store })`:
  - `storeAndEmit` → enqueue at now → kick private drain (never throws to engine)
  - private drain — serialized in-process; claim lease via reschedule; POST JSON
  - retry: network / 408 / 429 / 5xx → backoff; other 4xx → DLQ; exhaust → DLQ
  - `startTimers` (default 1s); drain not on the public interface
- Unit tests: build-event, retryable statuses, happy path, backoff, 4xx DLQ,
  exhaust, timer drain

**Review polish (same session):** dropped `fetchImpl` / `now` injection (tests use
`vi.stubGlobal('fetch')` + fake timers); renamed `emit` → `storeAndEmit`; un-exported
`drainDue` (timer + kick only).

**Not in this chunk:** `baseService.emitDeliveryEvent` still console stub; `main.ts`
does not construct the webhook service; unsolicited emit still omits `pluginId`
(fix when wiring in 3.1D).

**Next:** **3.1D** — inject webhook into `createBaseService` / fold emit; compose in
`main` when `config.eventWebhook` set; fix unsolicited `pluginId`; smoke.

### 2026-08-10 — session 35: Phase 3.1D — wire emit + composition root

**Landed:**

- `BaseService.emitDeliveryEvent` → optional `webhook.storeAndEmit` (no-op if unset)
- Removed free `emitDeliveryEvent` export; outgoing/incoming use `baseService`
- Unsolicited emit includes `pluginId: plugin.id`
- `main.ts`: build `createWebhookStore` + `createWebhookService` when
  `config.eventWebhook` set; pass into `createBaseService`; start webhook timers
  (independent of `engine.enabled`); boot log `eventWebhook=on|off`
- Unit: `base-emit.spec.ts`; opt-in integration: `webhook.smoke.spec.ts`

**Next:** **3.1E** HMAC (when asked) or **3.2** OpenAPI / **3.3** auth polish.

### 2026-08-10 — session 36: Phase 3.1E — opt-in webhook HMAC

**Landed:**

- `sign.ts` — HMAC-SHA256 over raw body; `sha256=<hex>` header format;
  `verifyWebhookSignature` (timing-safe) for consumers/tests
- `createWebhookService({ signingSecret? })` — when set, POST includes
  `X-Device-Messaging-Signature` + `X-Device-Messaging-Event-Id`
- `main.ts` — pass `DEVICE_MESSAGING_WEBHOOK_SECRET`; boot **warn** if
  `eventWebhook.url` set without secret (unsigned POSTs; does not fail boot)
- ADR-003 §6 signing no longer deferred; plan 3.1E checked; unit tests

**Phase 3.1 (event webhook) closed.** Next: **3.2** OpenAPI or **3.3** auth polish
(or PR for the 3.1 slice).

### 2026-08-12 — review: await webhook Redis enqueue before source cleanup

PR review caught fire-and-forget `store.enqueue` — engine could drop the device
message before the webhook event was durable.

**Landed (lean):**

- `storeAndEmit` / `emitDeliveryEvent` are `async`; **await Redis enqueue** only;
  HTTP drain remains fire-and-forget (ADR-003)
- Terminal paths reorder: await emit → then `messageFullCleanup` (incoming success,
  `retryOrFail` final, PULL age timeouts)
- `getPullTimeouts` no longer cleans up; caller emits then cleans
- First `SENT_TO_NS` and unsolicited await enqueue

HTTP delivery success remains independent of device-message outcome.

### 2026-08-12 — review: webhook POST timeout + body release

PR review: hung acceptor could stall the serialized drain and hold the claim lease;
unread response bodies could pin Undici connections.

**Landed:**

- `eventWebhook.requestTimeoutMs` (default `10000`) → `AbortSignal.timeout` on POST
- Cancel response body on every response path (success / 4xx / 5xx)
- Abort / network errors stay on the existing retry path
- ADR-003 / ADR-002 example / config.example.json + unit coverage

### 2026-08-12 — lean graceful shutdown (SIGTERM/SIGINT)

No process shutdown path existed; timer `{ stop }` handles were discarded.

**Landed in `main.ts`:** retain engine + webhook timer stops; on `SIGTERM`/`SIGINT`
stop timers → `app.close()` → `redisRepo.client.quit()` → exit. Idempotent guard;
does **not** await in-flight resolution/drain ticks (v1 / single-replica).

### 2026-08-12 — parked: shutdown awaits in-flight ticks / gate emit

PR review asked for `stop()` to expose bounded completion promises (engine ticks +
webhook `_drainDue`), await them before `process.exit`, and refuse `storeAndEmit`
after shutdown begins.

**Parked (graceful-shutdown v2).** Contradicts deliberate v1 lean shutdown. Engine
timers have no in-flight tracking and allow re-entrant ticks; full fix is a dedicated
chunk. Thin later option if needed: webhook `stop()` awaits current `drainChain` only
(already bounded by `requestTimeoutMs`).

### 2026-08-12 — cold-start docs: Phase 3 slice pointers

Aligned `AGENTS.md` Current status, plan 001 Phase 3 header/checklist, and this log’s
open-decisions blurb so a fresh chat without transcript sees: **3.1 closed → next 3.2
OpenAPI → then 3.3**; parked shutdown-v2 / drain concurrency called out.

### 2026-08-12 — session: Phase 3.2A1 — OpenAPI scaffold

**Locked (D1–D5):** `@fastify/type-provider-zod` + `@fastify/swagger` +
`@fastify/swagger-ui`; paths mirror `nxt-sts` (`/v3/api-docs`, `/swagger`); UI on;
docs unauthenticated; outbound webhook described later (no fake path).

**Landed:** deps; `registerOpenApi` in `src/http/openapi.ts`; Zod compilers + type
provider in `buildApp`; `/healthz` response schema; unit smoke for JSON + UI.

**Next (3.2A2):** migrate command + token routes from hand `safeParse` to Fastify
route `schema` (same Zod). Then ingress (3.2A3), then webhook components (3.2B).

### 2026-08-12 — session: Phase 3.2A2 — command + token route schemas

**Landed:** message + token routes use Fastify Zod `schema` (body/params/response);
`deviceMessagePublicSchema` / cancel / token / coarse `errorBodySchema`;
`registerCoarseValidationErrorHandler` keeps `{ error: 'Invalid request body' }`
until 3.3; OpenAPI smoke asserts command + token paths.

**Next (3.2A3):** ingress route schema (opaque body + `pluginId` params). Then 3.2B
webhook description.

### 2026-08-12 — session: Phase 3.2A2b — OpenAPI example polish

Swagger UI was inventing examples from Zod JSON-Schema integer extremes
(`Number.MIN_SAFE_INTEGER`) for unconstrained `z.number().int()` fields
(e.g. SET_DATE year/month/day).

**Landed:** calendar/time bounds + `.meta({ examples, description })` on create /
token / date-time schemas; `networkId` / relay `id` as `z.uint32()` so docs stay
sane; year still allows 2-digit (`0–9999`). OpenAPI unit asserts SET_DATE branch.

### 2026-08-13 — session: Phase 3.2A2c — Zod owns shared vocabulary

Removed TS/Zod double declarations for delivery status, cancel result, message
response, failure reason, and public message shape. Zod schemas are source of
truth; `types.ts` infers. `DeviceMessage` = public wire + `commandType: CommandType`
+ optional `concurrencyRateLimitKey`. `FailureContext` stays TS-only (engine
`skipRetry`, not on wire). Coarse validation params message →
`Invalid path parameters` (field-level Zod issues = 3.3).

### 2026-08-13 — session: Phase 3.2A2d–e — public commandType + webhook pick

- **3.2A2d:** `deviceMessagePublicSchema.commandType` → `z.enum(COMMAND_TYPES)`.
- **3.2A2e:** `webhookMessagePayloadSchema` = pick from public + partial (keep
  `deliveryStatus`/`device` required); `WebhookMessagePayload` inferred; webhook
  `types.ts` re-exports (no hand-written message duplicate).
- **Rename:** `deviceMessagePublicSchema` / `DeviceMessagePublic` →
  `deviceMessageResponseSchema` / `DeviceMessageResponse` (HTTP outgoing clear).

### 2026-08-13 — session: Phase 3.2A3 — ingress OpenAPI schema

**Landed:** `POST /ingress/:pluginId` uses Fastify Zod `schema` (params + opaque
`z.unknown()` body so raw Buffer still validates for signatures; 204/400/401
responses). OpenAPI smoke includes ingress path. **3.2A closed.**

**Next:** **3.2B** — outbound webhook in OpenAPI (`webhooks` / components) + plan /
AGENTS closeout.

### 2026-08-13 — parked: ChirpStack HTTP does not retry ingress

ChirpStack’s HTTP integration posts once, expects 2xx, and on failure **logs** — no
delivery retry loop. v1 still **awaits** `incomingService.handle` before 204 for
*local* durability (Redis work), not vendor recovery. Revisit only with a durable
raw-event enqueue → 204 → async process design. Not a 3.2 change.

### 2026-08-13 — session: Phase 3.2B — outbound webhook OpenAPI + closeout

**Landed:** `webhookEventSchema`; OpenAPI `components.schemas.WebhookEvent` +
`webhooks.deliveryEvent` (headers, no fake inbound path); `WebhookEvent` inferred;
plan 001 / AGENTS 3.2 → done; next **3.3**.

**Phase 3.2 closed.**

### 2026-08-13 — session: Phase 3.3A — timing-safe Bearer

**Landed:** `src/http/auth.ts` — parse case-insensitive `Bearer ` then
`timingSafeEqual` on the token vs `DEVICE_MESSAGING_API_KEY` (length-guard first,
same pattern as webhook signature verify). Same 401 `{ error: 'Unauthorized' }`
for missing / malformed / wrong. Opt-in unchanged (unset/empty key skips the
hook; `/healthz`, docs, ingress stay open). Helper stays local — no share with
`sign.ts`. Unit: `test/unit/http/auth.spec.ts`.

**Phase 3.3A closed.** Next: **3.3B** richer Zod validation error bodies
(field path + message; lock envelope before coding).

### 2026-08-13 — session: Phase 3.3B — validation error bodies + Phase 3 close

**Landed:** schema failures return
`{ error: 'Invalid request body' | 'Invalid path parameters', issues: [{ path, message }] }`.
`path` is dotted (`device.externalReference`); messages are Zod's. Domain/auth
errors still `{ error }` only (`issues` optional on `errorBodySchema`).
`registerCoarseValidationErrorHandler` → `registerValidationErrorHandler`.
Unit: `test/unit/http/validation-errors.spec.ts`.

**Phase 3.3 / Phase 3 closed.** Next: **Phase 4** (ADR-005 metrics, pino sweep,
integration guide). Parked unchanged: shutdown v2, webhook drain concurrency.

### 2026-08-13 — docs: canonical Parked / revisit table

Parked items were split across AGENTS (2 bullets), plan 001 Deferred (product
triggers only), carried findings (mixed historical table), and dated log notes
(ingress durability, sanitization). A cold reader would miss most of them.

**Landed (docs only):** `docs/decisions-log.md` § **Parked / revisit** is the
living list (this repo / product trigger / `nxt-backend`). `AGENTS.md` and plan
001 `## Deferred` point there — no second tables. Carried findings marked as
facts-not-todos.

**Next:** **Phase 4** when prompted. Use the new table; do not relitigate parked
items unless the maintainer picks one.

### 2026-08-14 — session: Phase 4.1A — `GET /metrics` scaffold

**Landed:** `prom-client` + `src/metrics/` (`createMetrics` dedicated `Registry`,
`GET /metrics` unauthenticated, hidden from OpenAPI). Smoke series
`device_messaging_up 1`. No engine increments; no Redis scrape. `buildApp`
registers metrics by default (injectable for later tests).

**Phase 4.1A closed.** Next: **4.1B** in-process counters / histogram (terminals,
retries, webhook results, unhandled ingress) — still inside `src/metrics/`;
engine only calls increment helpers.

### 2026-08-14 — session: Phase 4.1B — in-process counters

**Landed:** `src/metrics/` series + increment helpers (`recordMessageTerminal`,
`recordWebhookResult`, `recordIngressUnhandled`). Required `metrics: MetricsRecorder`
on base / incoming / outgoing / webhook factories and `buildApp`. Tests that do
not scrape pass `noopMetrics`; `metrics.spec.ts` uses `createMetrics()`. `main.ts`
shares one instance with HTTP and the engine. Call
sites: final `retryOrFail`, incoming success, PULL age timeout, successful cancel,
webhook posted/retried/dlq, PUSH `handle` returning null. Isolated-registry unit
tests.

**Phase 4.1B closed.** Next: **4.1C** queue-depth gauges (scrape-time Redis
pipeline; no new keys).




