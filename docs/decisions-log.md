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
| 7 | Tooling: build tool, test framework, linter, Node version, package manager | — (ADR-001 settled) |
| 8 | Public contract: endpoints including token generation, webhook payload and signing, auth. **The consequential one** — `nxt-backend` ADR-010 calls the outbound webhook "the single most consequential interface decision" | — |
| 9 | Deployment and OSS hygiene: Dockerfile, docker-compose, CI, metrics, CONTRIBUTING | 7 |

Decisions 5 (transfer mechanics + phase order) and 6 (scope) are **settled** — see the log below and
`docs/plans/001-extraction.md`.

Two further items are owned by `nxt-backend`, not this repo:

- Re-cutting `nxt-backend`'s plan 001 into a per-repo pair (blocked on decision 5).
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
| `nxt-backend` ADR-010 decision 2's endpoint list has **no token endpoint**, and neither does plan 001's Phase 2 — despite `deviceTokenService.generate()` being one of five live consumer call sites, and a *synchronous* one (it returns a token inline; it is not a queued message) | ADR-010 amendment ✅, then decision 8 |
| `cancelOneByMeterInteractionId` and `cancelManyByMeterInteractionIds` have **zero callers** anywhere in `legacy/`. ADR-010 commits to `DELETE /messages/:correlationId` for an unused capability; the batch variant is in no plan at all | Decision 6 |
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
