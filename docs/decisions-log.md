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
| 5 | Code transfer mechanics (preserve git history vs. clean copy) and the revised phase ordering | — |
| 6 | Extraction scope: what travels, what is dropped (calin-api-v1's future, dead files, whether the cancel API ships in v1) | — |
| 7 | Tooling: build tool, test framework, linter, Node version, package manager | ADR-001 |
| 8 | Public contract: endpoints including token generation, field renames, webhook payload and signing, auth | 5, 6 |
| 9 | Deployment and OSS hygiene: Dockerfile, docker-compose, CI, metrics, CONTRIBUTING | 7 |

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
| `nxt-backend` plan 001's Phase 1 cannot execute — it edits files in the frozen `legacy/` tree. Decoupling moves *after* the copy, into this repo. A phase inversion, not a tweak | Plan re-cut (decision 5) |
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
description, `AGENTS.md`, ADR-001, ADR-002, and this log.
