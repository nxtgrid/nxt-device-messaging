# Extraction Plan — device-messages → nxt-device-messaging

**Decisions:** ADR-001 (runtime), ADR-002 (config), ADR-003 (HTTP contract), ADR-004 (tooling),
ADR-005 (deployment / OSS hygiene), `nxt-backend` ADR-010 + its 2026-07-27 amendment
**Plan number:** 001
**Created:** 2026-07-27
**Status:** Phase 0 not started

Supersedes `nxt-backend`'s `docs/plans/001-device-messaging-service-extraction.md`, which is marked
stale. That document is still useful as the **source of task detail** (retry semantics, queue stages,
plugin interface sketch) — but its phase order, framework assumptions, and several task descriptions
are wrong. Read `nxt-backend` ADR-010's amendment before using it. Phase 3 implements **ADR-003**,
not the stale plan's Nest controllers.

---

## How to work in this plan

1. Read `AGENTS.md` (origin, baseline, governance) and `docs/decisions-log.md` (what is settled vs
   open) first.
2. **The source is `legacy/apps/tiamat/src/modules/device-messages/` in `nxt-backend`, frozen at
   `db5c2ac`.** Both repos are in the same Cursor workspace. Read the source, never a description
   of it.
3. Port **one unit at a time**, in order. Each unit ends with the repo compiling. Stop after each
   unit for review — do not run ahead.
4. **Update the import ledger** as each file lands. The ledger, not git history, is the authoritative
   record of what has been re-homed. A source file is only marked done when *every* behaviour in it
   has a home.
5. Record deviations — anything not a faithful port — in the decisions log with a reason.

## Phases

| Phase | Scope | Status |
|---|---|---|
| **0** | Scaffold: Fastify app, config loader (ADR-002), tooling, compose skeleton. No domain code | Not started |
| **1** | Foundation + engine: units 1–6. Ends when the engine boots and cycles against a local Valkey | Not started |
| **2** | Adapters as plugins: units 7–10 (`calin-chirpstack`, `calin-api-v1`, `calin-api-v2`, `nxt-sts`) | Not started |
| **3** | HTTP contract per **ADR-003**: enqueue/cancel/inspect, token, ingress, outbound webhook, auth, OpenAPI | Not started |
| **4** | Deployment + hygiene: metrics, structured logging, integration guide, CI | Not started |

Phase 3 is unblocked (**Decision 8 → ADR-003**). Phase 0 tooling and deployment shapes are
settled (**Decision 7 → ADR-004**, **Decision 9 → ADR-005**). Phase 0 can start; Phase 4
implements the observability and hygiene pieces ADR-005 scopes to that phase.

## Port units

Dependency-ordered, bottom-up. Adapters are ported **directly into plugin shape** — one pass, not
port-then-convert (a deliberate merge of move-and-modify; the per-unit review is the control).

### Phase 1

- [ ] **Unit 1 — Types and utilities.** `lib/types.ts`, new `lib/utils.ts`.
      Vendor `PhaseEnum` (`'A' | 'B' | 'C'`), a local `Json`, `command_type: string` (opaque to core;
      plugins close the set — ADR-003 §4), the token and phase-read predicates, and the two helper
      functions. Verify predicate string values against
      `legacy/.../meter-interactions/lib/meter-interaction-type-helpers` before copying. Drop
      public `DeviceManufacturerEnum` / `DeviceProtocolEnum` in favour of `pluginId` (ADR-003 §3).
- [ ] **Unit 2 — Redis repository and Lua. ⚠ Riskiest unit; review carefully.**
      `redis-repository/{index,keys,helpers}.ts` + the four files from
      `legacy/apps/tiamat/src/queries/lua/device-messages/`. Load the `.lua` files locally rather than
      via `@tiamat/queries`. `HERMES_*` → `REDIS_*` (ADR-002 §8). Full-pipeline field renames
      (ADR-003 §2) land here: `meter_interaction_id` → `correlation_id` (opaque **string**),
      `grid_id` → `network_id` (**`number | null`** — the `unassigned` LoRaWAN bucket must survive),
      `message_type` → `command_type`, and the index key prefix `idx:meter_interaction_id:` →
      `idx:correlation_id:`.
- [ ] **Unit 3 — Queue primitives.** `queue-moving{,.push,.pull}.ts`, `retry-helpers.ts`.
      The hardcoded timeout/retry constants become config-backed with in-code defaults (ADR-002 §5).
- [ ] **Unit 4 — Lifecycle.** `lifecycle.push.ts`, `lifecycle.pull.ts`.
- [ ] **Unit 5 — Core engine, framework-stripped.** `device-messages.service.ts`,
      `outgoing.service.ts`, `incoming.service.ts`, `token.service.ts`.
      `@Injectable`/`@Module` removed; the two `@Cron` jobs become interval timers gated on
      `engine.enabled` (ADR-002 §7 — **not** `NXT_ENV`); DI constructors dissolve into the
      composition root. `subscribe()`/`static subscribers` stay in place for now and are replaced by
      the outbound webhook in Phase 3 (**ADR-003** §6).
      **Behaviour note:** `@Cron` does not guard re-entry; a plain `setInterval` reproduces that.
      Adding an in-flight guard is an improvement — record it if taken.
- [ ] **Unit 6 — Plugin interface and registry.** `lib/plugin.interface.ts`,
      `lib/plugin-registry.ts`. Interface sketch is in `nxt-backend` plan 001 task 3.1; correct
      `network_id` to `number | null`, key plugins by `pluginId`, add token capability and
      per-plugin command-type validation (ADR-003 §§3–4), optional `verifySignature` for ingress.
      Only plugins present in config are constructed (ADR-002 §6).

### Phase 2 — adapters as plugins

- [ ] **Unit 7 — `calin-chirpstack`** (~1,200 lines). Source folder is still
      `adapters/calin-lorawan/` in `legacy/`; destination plugin id/folder is `calin-chirpstack`
      (ADR-003 §3). `_incoming`, `_outgoing`, `lib/{types, encode-request-data,
      decode-response-data, correlate-request-response, connectivity-helpers}`, plus
      `lib/chirpstack-repository/` moved in as plugin-internal. `bottleneckKey` must handle the
      `unassigned` bucket.
- [ ] **Unit 8 — calin-api-v1** (~726 lines). Actively supported; V1 meters are in the field.
      Second real adapter, so this is what validates the plugin SPI (`nxt-backend` ADR-001).
- [ ] **Unit 9 — calin-api-v2** (~500 lines).
- [ ] **Unit 10 — nxt-sts token plugin** (46 lines). `HttpService` → native `fetch`.

## Import ledger

Every source file in scope. Status: `pending` / `ported` / `dropped` / `deferred`.
Paths are relative to `legacy/apps/tiamat/src/modules/device-messages/` unless noted.

| Source file | Lines | Unit | Status |
|---|---|---|---|
| `lib/types.ts` | 175 | 1 | pending |
| *(new)* `lib/utils.ts` — vendors `generateRandomNumber`, `toSafeNumberOrNull` | — | 1 | pending |
| `lib/redis-repository/index.ts` | 472 | 2 | pending |
| `lib/redis-repository/keys.ts` | 94 | 2 | pending |
| `lib/redis-repository/helpers.ts` | 100 | 2 | pending |
| `../../queries/lua/device-messages/fetch-next-message-in-queue.lua` | 84 | 2 | pending |
| `../../queries/lua/device-messages/fetch-next-message-in-queue.types.ts` | 38 | 2 | pending |
| `../../queries/lua/device-messages/move-message-between-queues.lua` | 75 | 2 | pending |
| `../../queries/lua/device-messages/move-message-between-queues.types.ts` | 33 | 2 | pending |
| `lib/queue-moving.ts` | 185 | 3 | pending |
| `lib/queue-moving.push.ts` | 106 | 3 | pending |
| `lib/queue-moving.pull.ts` | 59 | 3 | pending |
| `lib/retry-helpers.ts` | 45 | 3 | pending |
| `lib/lifecycle.push.ts` | 82 | 4 | pending |
| `lib/lifecycle.pull.ts` | 138 | 4 | pending |
| `device-messages.service.ts` | 140 | 5 | pending |
| `outgoing.service.ts` | 354 | 5 | pending |
| `incoming.service.ts` | 163 | 5 | pending |
| `token.service.ts` | 36 | 5 | pending |
| `dto/create-device-message.dto.ts` | 25 | 5 | pending |
| `dto/generate-token.dto.ts` | 17 | 5 | pending |
| `device-messages.module.ts` | 37 | 5 | **dropped** — superseded by the composition root (ADR-001 §2) |
| `adapters/calin-lorawan/_outgoing.service.ts` → plugin `calin-chirpstack` | 77 | 7 | pending |
| `adapters/calin-lorawan/_incoming.service.ts` → plugin `calin-chirpstack` | 135 | 7 | pending |
| `adapters/calin-lorawan/lib/types.ts` → plugin `calin-chirpstack` | 86 | 7 | pending |
| `adapters/calin-lorawan/lib/encode-request-data.ts` → plugin `calin-chirpstack` | 360 | 7 | pending |
| `adapters/calin-lorawan/lib/decode-response-data.ts` → plugin `calin-chirpstack` | 422 | 7 | pending |
| `adapters/calin-lorawan/lib/correlate-request-response.ts` → plugin `calin-chirpstack` | 113 | 7 | pending |
| `adapters/calin-lorawan/lib/connectivity-helpers.ts` → plugin `calin-chirpstack` | 20 | 7 | pending |
| `lib/chirpstack-repository/index.ts` → plugin `calin-chirpstack` | 109 | 7 | pending — **see coupling note below** |
| `adapters/calin-lorawan/lib/_UNUSED_EXAMPLE_correlate-request-response.redis.ts` | 138 | — | **dropped** — dead code |
| `adapters/calin-api-v1/_outgoing.service.ts` | 222 | 8 | pending |
| `adapters/calin-api-v1/_incoming.service.ts` | 274 | 8 | pending |
| `adapters/calin-api-v1/_token.service.ts` | 97 | 8 | pending |
| `adapters/calin-api-v1/lib/repo.ts` | 133 | 8 | pending |
| `adapters/calin-api-v2/_outgoing.service.ts` | 196 | 9 | pending |
| `adapters/calin-api-v2/_incoming.service.ts` | 198 | 9 | pending |
| `adapters/calin-api-v2/_token.service.ts` | 82 | 9 | pending |
| `adapters/calin-api-v2/lib/repo.ts` | 212 | 9 | pending — **see coupling note below** |
| `adapters/nxt-sts/_token.service.ts` | 46 | 10 | pending |

### Coupling note — vendor clients shared with `meter-installs`

Two files in this ledger have consumers **outside** device-messages that stay in `nxt-backend`:

- `lib/chirpstack-repository/index.ts` — `meter-installs/adapters/calin-lorawan/_install.service.ts`
  uses `registerDevice()` and `setApplicationKeyForDevice()`.
- `adapters/calin-api-v2/lib/repo.ts` — `meter-installs/adapters/calin-api-v2/_install.service.ts`
  uses `sendCalinApiV2Request`, `CalinApiV2Error`, and two response types.

Extracting them leaves nxt-backend's **hardware provisioning** without its vendor clients. Hardware
provisioning is **out of scope here** and no decision has been made about it. This is a finding for
nxt-backend's Metering import to resolve — do not expand scope to cover it. It does **not** block any
unit in this plan; the files port normally.

The type imports in `meter-installs.service.ts` / `meter-uninstalls.service.ts`
(`DeviceManufacturerEnum`, `DeviceProtocolEnum`, `NetworkServerImplementation`) are already resolved:
those enums stay in nxt-backend as code (`nxt-backend` ADR-010 §4, ADR-007 §6).

## Deferred

| Item | Why | Revisit when |
|---|---|---|
| Message-bus adapter for results | ADR-003: HTTP webhook is v1; bus stays optional | A consumer needs broker delivery |
| Dead-letter admin/replay HTTP | ADR-003 keeps failed callbacks in Redis TTL; no admin route yet | Ops needs replay without Redis access |
| Domain vocabulary rename (`DeviceMessage` → dispatch-flavoured) | Would touch the Redis key schema and both Lua scripts during a behaviour-preserving move | Service is real and test-covered (ADR-001, Rejected) |
| HA / multi-instance (leader election, Redis-backed correlator) | `nxt-backend` ADR-010 §6 defers it | Evidence of multi-instance demand |

Cancel is **not** deferred — ADR-003 ships `POST /message/cancel` and `POST /messages/cancel`.

## Notes & decisions log

Deviations and per-unit notes go in `docs/decisions-log.md`, not here — one chronological record for
the whole effort.
