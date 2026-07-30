# Decisions Log — nxt-device-messaging

Chronological record of decisions and deviations, appended every working session. Format:
`YYYY-MM-DD — note`. Architectural decisions get a full ADR in `docs/architecture/`; this log
records what happened, when, and what is still open — the things an ADR is the wrong shape for.

**Read this first when picking up work after a gap.** It is the only place that tells you what is
settled versus still open.

---

## Open decisions

Ordered by dependency. Nothing below is decided; do not act on any of it without the maintainer.

| # | Decision | Blocked on |
|---|---|---|
| — | *(none blocking Intermezzo close / I4; Unit 5.2+ paused)* | — |

### Deferred with locked criteria

These are **not** free-for-all open questions. Criteria and interim seams live in the cited ADR.
Revisit only in the named unit; record the choice in this log and amend the ADR if needed.

| # | Topic | Revisit at | Interim until then | ADR |
|---|---|---|---|---|
| D1 | `queueKey → pluginId` for distribute (Redis map vs boot-time kind registry) | Unit 5.3 **after** Intermezzo | None (no distributor yet) | 006 |
| D2 | Whether `messageFullCleanup` needs more than `inFlightQueueKeys[]` + `concurrencyRateLimitKey` | Unit 5.3+ / cleanup paths **after** Intermezzo | Parameterized options on the Redis repo (Unit 2); no gateway key invention | 006 |
| D3 | Wire named admission strategies into `distribute` | Unit 5.3 **after** Intermezzo | None | 006 |
| D4 | Plugin-local key vocabulary (`gateway` vs `dcu`, etc.) | Plugin units 7–9 | Plugin-owned; no core constant | 006 |
| D5 | Stage timeouts / poll delays leave shared `delivery.*` → plugin `tuning` | Unit 5 / plugins **after** Intermezzo | Unit 3 globals on `delivery` (legacy defaults); do not treat as end state | 002 |

Decisions 5 (transfer mechanics + phase order), 6 (scope), **7 (tooling → ADR-004)**,
**8 (public HTTP contract → ADR-003)**, **9 (deployment / OSS hygiene → ADR-005)**, and
**10 (bottleneck + admission → ADR-006)** are **settled** — see the log below and
`docs/plans/001-extraction.md`.

**Course correction (2026-07-30):** bottom-up Unit 5.2+ is **paused**. Phase 1b Intermezzo
**I0–I3 done** (HTTP↔Redis exit met). Next: **I4** optional or close Intermezzo, then
resume 5.2+. See session 12–15c and plan **Phase 1b**.

Phase 0 scaffold is **done**. Phase 1 Units 1–4, pre–Unit 5 SPI, and Unit **5.1** are
**done**. **Do not** continue Unit 5.2 until the Intermezzo is closed. Then resume 5.2+/D1–D3
against a curl-able path. Also outstanding on `nxt-backend`:

- Re-cutting `nxt-backend`'s plan 001 into a per-repo pair (blocked on decision 5 — mechanics
  settled; the re-cut itself may still be outstanding on that side).
- The device-messaging **cutover addendum** for the company, reconciled with `nxt-backend`
  ADR-012 (see "Carried findings" below).

---

## Carried findings

Facts established during planning that are not yet reflected in the documents they contradict.
Each needs to land somewhere before it can be dropped from this list.

| Finding | Lands in |
|---|---|
| **Vendor clients are shared with `meter-installs`.** `lib/chirpstack-repository/index.ts` (`registerDevice`, `setApplicationKeyForDevice`) and `adapters/calin-api-v2/lib/repo.ts` (`sendCalinApiV2Request`, `CalinApiV2Error`) are imported by `meter-installs/adapters/{calin-lorawan,calin-api-v2}/_install.service.ts`, which stays in `nxt-backend`. Extracting them leaves nxt-backend's hardware provisioning without its vendor clients. **Out of scope here, undecided** — three eventual options: re-implement thin provisioning clients in Metering, expose provisioning endpoints from this service, or share a package | `nxt-backend` Metering import (002f) |
| ~~`nxt-backend` plan 001's Phase 1 cannot execute — it edits files in the frozen `legacy/` tree~~ | ✅ ADR-010 amendment §B, plan 001 stop-banner, `docs/plans/001-extraction.md` |
| ~~`nxt-backend` ADR-010 decision 2's endpoint list has **no token endpoint**~~ | ✅ ADR-010 amendment §C, then **ADR-003** (`POST /token/generate`) |
| ~~Cancel had zero callers; Decision 6 deferred the route~~ | ✅ **ADR-003** ships single + batch cancel anyway (logic already existed; useful for adopters) |
| Plan 001's external-import table understates the coupling: `@core/types/device-messaging` appears in **8** files (not 3), `@core/types/supabase-types` in **5** (not 1), `@helpers/number-helpers` in **4** (not 1) | Plan re-cut (decision 5) |
| `adapters/calin-lorawan/lib/_UNUSED_EXAMPLE_correlate-request-response.redis.ts` is dead code and should not travel | Decision 6 |
| Baseline commit `db5c2ac` made `grid_id` nullable and added `LORAWAN_UNASSIGNED_BUCKET` (`queue:lorawan_network:unassigned`). This invalidates plan 001 task 1.6's target type (`network_id: number`) and task 3.3's example `bottleneckKey`, which would route orphan meters to `queue:lorawan_network:null` and lose them | Plan re-cut (decision 5) |
| Device-messaging cutover is **hard stop-then-start, not blue/green** — ChirpStack posts to exactly one integration URL, and dual polling of a vendor API double-processes. Same mechanics `nxt-backend` ADR-012 decision 2 assigns to `worker` | Cutover addendum |
| `nxt-backend` ADR-012's step-4 sequence is missing three device-messaging items: the ChirpStack integration URL flip, an in-flight drain of the old Valkey, and provisioning this service's own Valkey plus config and secrets ahead of the window | Cutover addendum |
| Under wholesale cutover this service carries **zero production traffic until cutover day** — so ADR-010's self-identified riskiest interface (the outbound webhook) is first exercised inside a window with no rollback past it (`nxt-backend` ADR-012 decision 5). Needs the rehearsal step attached | Cutover addendum |
| **Open question for the cutover addendum:** does the early adopter (`nxt-backend` roadmap deployment consumer #3) run CALIN meters and ChirpStack? If so they are the natural first production user *before* the company, which retires most of the above risk | Ask the maintainer when authoring |

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
- **Name `nxt-device-messaging` stands.** The rename to `nxt-device-dispatch` was considered and
  **declined**: the internal vocabulary is message-centric throughout (`DeviceMessage`,
  `CreateDeviceMessageDto`, the `device_messages` keyspace, both Lua script names,
  `runMessageResolutionCycle`), so renaming the artifact alone relocates the mismatch, and renaming
  the vocabulary too would touch the Redis key schema and Lua scripts during a move meant to
  preserve behaviour. The real concern behind the rename — that "messaging" reads as SMS, which the
  estate genuinely also does — is addressed by README positioning and a "What this is not" section
  instead. Recorded as declined so it is not relitigated. Derived identifiers: npm
  `nxt-device-messaging` (private), env prefix `DEVICE_MESSAGING_*`, type `DeviceMessagingPlugin`,
  image `ghcr.io/nxtgrid/nxt-device-messaging`.
- **Configuration follows `nxt-backend` ADR-007's mechanism, adapted** → **ADR-002**. JSON artifact
  for topology, non-secret settings, and tuning; secrets in env only; plugin-contributed Zod schemas
  composed at registration; plugin tuning defaults in code, overridable by config. Two deliberate
  behaviour changes from the inherited module: `engine.enabled` replaces `NXT_ENV !== 'production'`
  cron gating (which made the engine inert outside production), and `HERMES_*` becomes `REDIS_*`.

**Established as fact:**

- The source module is **frozen at `db5c2ac`** and at parity with company production; neither
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
the **`talos` app** (whose job was CALIN-v1 hardware provisioning), not the CALIN V1 protocol. V1 is
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

| Concern | Choice |
|---|---|
| Package manager | pnpm (Corepack `packageManager` pin; exact patch at scaffold) |
| Node | 24.x (current LTS major; `engines`) |
| Module system | ESM (`"type": "module"`) |
| Build | tsup (esbuild); Lua scripts copied beside output |
| Dev / scripts | tsx |
| Tests | Vitest |
| Lint | ESLint 9 flat + typescript-eslint; house `teamRules` adapted (no Nx, no estate-only restricted imports) |

**Explicitly rejected:** Prettier, Biome, `@stylistic/eslint-plugin`, Jest, webpack/`tsc`-only as
primary build. Style stays in ESLint core rules as in `nxt-backend/eslint.config.mjs`.

**Unblocks** Decision 9 (Docker/CI/hygiene). Phase 0 can use this stack; compose/CI half of Phase 0
and Phase 4 still wait on Decision 9.

**Written:** ADR-004. `AGENTS.md` ADR index, open-decisions table, and `docs/plans/001-extraction.md`
header/status notes updated.

### 2026-07-28 — session 3 (continued): Decision 9 — deployment and OSS hygiene

**Decided → ADR-005.** Patterns aligned with sibling OSS service `nxt-sts` (tag → GHCR, image
HEALTHCHECK, PaaS-from-GitHub health note), adapted for Valkey.

| Concern | Choice |
|---|---|
| Dockerfile | Multi-stage `node:24-slim`; non-root; `HEALTHCHECK` → `/healthz` |
| Compose | App + Valkey 8 alpine; `.env.example`; `.dockerignore` |
| Port | **3100** (misses estate api 3000 and `nxt-sts` 8080) |
| CI | `build.yml` (PR + default branch: lint/test/build); `release.yml` (tags `v*.*.*` → GHCR `:tag` + `:latest`) |
| Metrics | `GET /metrics` Prometheus via `prom-client` (min: queue depth, terminal status counters, retry histogram) |
| Health | `GET /healthz`; README documents image HEALTHCHECK vs PaaS probe (nxt-sts dual-path note) |
| Logging | Fastify pino, JSON in production |
| Hygiene | `CONTRIBUTING.md`, issue-template stubs; LICENSE already MPL-2.0 |

**Phase split:** Phase 0 lands Docker/compose/CI stubs; Phase 4 lands metrics, pino sweep,
CONTRIBUTING polish, README deploy/health section.

**Open decisions in this repo:** none. Next work is Phase 0 scaffold execution.

**Written:** ADR-005. `AGENTS.md` ADR index, open-decisions table, and `docs/plans/001-extraction.md`
updated.

### 2026-07-28 — session 4: Phase 0 scaffold execution

Executed Phase 0 end-to-end (prior sessions had locked ADR-001–005; this session ran the
scaffold).

**Landed:**

- **Tooling / hooks** (Steps 1–1b, earlier in Phase 0): pnpm@11.17.0, Node 24, ESM, tsup, tsx,
  Vitest, ESLint (house teamRules adapted), husky + lint-staged; pre-commit = lint-staged then
  `pnpm typecheck`.
- **Config loader** (Step 2): async `loadConfig` (JSON → URL → PATH → `config.default.json`),
  `getConfig` / `setConfig`, Zod schema, `config.default.json` + `config.example.json`, unit
  tests under `test/unit/`.
- **Fastify shell** (Step 3): `buildApp()` + `GET /healthz` → `{ ok: true }`; listen on
  `0.0.0.0`, port from **`PORT`** (default **3100**). Liveness stub landed early so the image
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

1. **No core `lib/utils.ts`.** `generateRandomNumber` and `toSafeNumberOrNull` are only used
   by adapters → deferred to plugin units 7–10.
2. **No token / phase-read predicates in core.** Those encode CALIN command vocabulary;
   ADR-003 §4 says plugins close `command_type`. Predicates land with the plugins that need
   them (verify strings against `meter-interaction-type-helpers` at that time — including
   `DELIVER_PREEXISTING_TOKEN`, not the stale plan’s `DELIVER_TOKEN`).
3. **No `NetworkServerImplementation` / `PULL_PATTERN_IMPLEMENTATIONS`.** Core must not
   hardcode which plugin ids are PULL. Each plugin will declare PUSH vs PULL on the plugin
   interface; the registry (Unit 6) exposes that to the engine. PULL awaiting-task keys use
   `pluginId` (ADR-006); initial queues use plugin `bottleneckKey`, not a core switch.
4. **No `BUNDLED_PLUGIN_IDS` in core.** Bundled ids live in ADR-003 and on each plugin
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

**Landed:** `src/lib/redis-repository/{index,keys,helpers}.ts` and `src/lib/redis-repository/lua/{fetch-next-message-in-queue,move-message-between-queues}.*` plus their TS type companions.

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
2. **PULL uses `pluginId`.** `fromNsToAwaitingTask({ pluginId })` →
   `queueAwaitingTask(pluginId)`; dropped `NetworkServerImplementation`.
3. **`fromAnyToRetry` concurrency seam.** Optional `concurrencyRateLimitKey` (SREM), mirroring
   Unit 2 `messageFullCleanup` — no `device.gateway` parse / gateway key invention.
4. **PUSH/PULL stay separate modules** (no registry yet). Callers choose; Unit 6 wires
   `deliveryPattern`. No admission / `bottleneckKey` / distribute here (D1/D3).

**Checks:** `pnpm typecheck` / `lint` / `test` / `build`.

**Next:** Phase 1 Unit 4 (lifecycle) after review.

### 2026-07-29 — session 8b: lock D5 (stage timeouts → plugin tuning)

**Locked — D5.** Unit 3’s placement of `nsInFlightTimeoutMs`, `gwInFlightTimeoutMs`,
`deviceInFlightTimeoutMs`, and `initialPollDelayMs` on shared `delivery.*` is **interim only**.
End state (ADR-002 §5 + nxt-backend ADR-001): those knobs live in **plugin `tuning`**
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

1. **Interim structural minima, not `*Adapter` / `*Handlers`.**
   `PushIncoming` / `PushOutgoing` / `PullIncoming`; param named `plugin`. Deleted at
   Unit 6 in favour of `DeviceMessagingPlugin` (not grown into a parallel SPI).
2. **PULL takes `pluginId`(s).** `pollAwaitingTasksFor(pluginId, plugin)`;
   `getPullTimeouts(now, pluginIds, cleanupOptions?)` — no `PULL_PATTERN_IMPLEMENTATIONS`,
   no registry.
3. **Max age + poll-delay ladder = module defaults.** 48h / age ladder stay in
   `lifecycle.pull.ts` with D5 note; do not grow interim `delivery.*`.
4. **No `PULL_MAX_CONCURRENT_*` export.** Legacy constant belonged to distribute
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

1. **No in-process `subscribe` / `publish`.** Replaced by `emitDeliveryEvent` stub.
   Adopter touchpoint is `resultWebhook.url` (ADR-003 §6); full webhook lands Phase 3.
2. **`requeueMessage` uses `plugin.bottleneckKey`** via `plugin_id` from Redis — not
   legacy `queueInitial`. Missing plugin → warn + drop from retry.
3. **`retryOrFail` optional `concurrencyRateLimitKey`** (D2 interim seam; unused until
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

