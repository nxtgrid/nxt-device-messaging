# Extraction Plan — device-messages → nxt-device-messaging

**Decisions:** ADR-001 (runtime), ADR-002 (config), ADR-003 (HTTP contract), ADR-004 (tooling),
ADR-005 (deployment / OSS hygiene), ADR-006 (bottleneck + admission), `nxt-backend` ADR-010 +
its 2026-07-27 amendment
**Plan number:** 001
**Created:** 2026-07-27
**Status:** Phase 0 complete; Phase 1 foundation through 5.1; **Phase 1b Intermezzo closed
(I0–I3; I4 skipped). Next: Unit 5.2+ (cancel engine + thin cancel HTTP)**

Supersedes `nxt-backend`'s `docs/plans/001-device-messaging-service-extraction.md`, which is marked
stale. That document is still useful as the **source of task detail** (retry semantics, queue stages,
plugin interface sketch) — but its phase order, framework assumptions, and several task descriptions
are wrong. Read `nxt-backend` ADR-010's amendment before using it. Phase 3 is **ADR-003 polish**
(webhook HMAC/DLQ, OpenAPI, auth); command/ingress routes land thin with the engine units that
need them (same pattern as Intermezzo enqueue/get).

---

## How to work in this plan

1. Read `AGENTS.md` (origin, baseline, governance) and `docs/decisions-log.md` (what is settled vs
   open) first.
2. **The source is `legacy/apps/tiamat/src/modules/device-messages/` in `nxt-backend`, frozen at
   `db5c2ac`.** Both repos are in the same Cursor workspace. Read the source, never a description
   of it.
3. Port / implement **one chunk at a time**, in the order the plan currently states. Each chunk
   ends with the repo compiling. Stop after each chunk for review — do not run ahead.
4. **End-to-end rule (after Intermezzo):** each Unit 5 slice that has an ADR-003 **command or
   ingress** surface ships **thin HTTP + httpYac smoke in the same chunk** (lean routes like
   enqueue/get — not full OpenAPI/HMAC). Timer-only engine work (distribute, send, poll) has
   **no** public route; exercise via bootable stub plugins + enqueue/get (and tests that may
   invoke one tick). Do not invent a debug `POST /distribute` unless the maintainer asks.
5. **Update the import ledger** as each legacy file lands. The ledger, not git history, is the
   authoritative record of what has been re-homed. A source file is only marked done when *every*
   behaviour in it has a home.
6. Record deviations — anything not a faithful port — in the decisions log with a reason.
7. **End-of-chunk ritual:** update `AGENTS.md` status, this plan’s checkboxes, and
   `docs/decisions-log.md`; then write a **carry-over prompt** for the next fresh chat (done /
   next / out of scope / who drives). Cold sessions must not need the prior transcript if those
   three files + the prompt agree.

## Phases

| Phase | Scope | Status |
|---|---|---|
| **0** | Scaffold: Fastify app, config loader (ADR-002), tooling, compose skeleton. No domain code | **Done** |
| **1** | Foundation: units 1–4, pre–Unit 5 SPI, Unit 5.1; then 5.2+ after 1b | Foundation through 5.1; **resume 5.2+** |
| **1b** | **Walking skeleton Intermezzo** — stub plugins, thin HTTP, enqueue→Redis | **Closed** (I0–I3; I4 skipped) |
| **2** | Adapters as plugins: units 7–10 (`calin-chirpstack`, `calin-api-v1`, `calin-api-v2`, `nxt-sts`) | Not started |
| **3** | ADR-003 **polish**: webhook HMAC/DLQ, OpenAPI, auth hardening (routes already thin-landed earlier) | Not started; enqueue/get in 1b; cancel/token/ingress with Unit 5 |
| **4** | Deployment + hygiene: metrics, structured logging, integration guide, CI | Not started |

Phase 0 is **done**. Phase 1 foundation (Units 1–4, pre–Unit 5 SPI, Unit 5.1) is **done**.
**Phase 1b is closed.** Resume Unit 5.2+ against the curl-able stub path. Phase 4 still owns
ADR-005 observability hygiene (metrics, pino sweep, CONTRIBUTING/README) — CI/Docker stubs
already in Phase 0.

## Port units

Foundation was bottom-up; Intermezzo locked the outside-in path; **Unit 5.2+ resumes** with the
end-to-end rule above. Adapters remain one-pass into plugin shape (per-unit review is the control).

### Phase 1

- [x] **Unit 1 — Core types.** `src/lib/types.ts` only.
      Vendor `PhaseEnum` (`'A' | 'B' | 'C'` — core-essential: Redis correlation indexes append
      `_ph{phase}` for per-phase messages), `response.data` as `Record<string, unknown>`,
      `command_type: string` (opaque to core;
      plugins close the set — ADR-003 §4), ADR-003 field renames, `pluginId` on the create/message
      shape, `device` identity-only (no manufacturer/protocol). **Not** in core: CALIN command
      predicates, `generateRandomNumber` / `toSafeNumberOrNull` (plugin units), or
      `PULL_PATTERN_IMPLEMENTATIONS` (plugins declare PUSH/PULL at registration — Unit 6).
- [x] **Unit 2 — Redis repository and Lua. ⚠ Riskiest unit; review carefully.**
      `redis-repository/{index,keys,helpers}.ts` + the four files from
      `legacy/apps/tiamat/src/queries/lua/device-messages/`. Load the `.lua` files locally rather than
      via `@tiamat/queries`. `HERMES_*` → `REDIS_*` (ADR-002 §8). Full-pipeline field renames
      (ADR-003 §2) land here: `meter_interaction_id` → `correlation_id` (opaque **string**),
      `grid_id` → `network_id` (**`number | null`** — the `unassigned` LoRaWAN bucket must survive),
      `message_type` → `command_type`, and the index key prefix `idx:meter_interaction_id:` →
      `idx:correlation_id:`. **Per ADR-006:** omit `queueInitial` (plugins own `bottleneckKey`);
      `queueAwaitingTask(pluginId)`; `messageFullCleanup` takes `inFlightQueueKeys` (interim —
      see ADR-006 D2). No admission engine and no `queueKey → pluginId` map yet (D1/D3).
- [x] **Unit 3 — Queue primitives.** `queue-moving{,.push,.pull}.ts`, `retry-helpers.ts`.
      Hardcoded timeout/retry constants → `delivery.*` passed into helpers (ADR-002 §5).
      **Interim:** stage timeouts on `delivery` — end state is plugin `tuning` (**D5**).
      PULL `fromNsToAwaitingTask` takes `pluginId` (not `NetworkServerImplementation`).
      `fromAnyToRetry` optional `concurrencyRateLimitKey` (ADR-006; mirrors Unit 2 cleanup).
      No distribute admission / `bottleneckKey` here.
- [x] **Unit 4 — Lifecycle.** `lifecycle.push.ts`, `lifecycle.pull.ts`.
      PUSH: `getPushTimeouts` / `maybeExtendMessageInGwQueue`. PULL:
      `pollAwaitingTasksFor(pluginId, plugin)` / `getPullTimeouts(now, pluginIds)` — no
      hardcoded PULL ids. Interim structural minima (`PushIncoming` / `PushOutgoing` /
      `PullIncoming`; param `plugin`) — deleted at Unit 6 for `DeviceMessagingPlugin`.
      Max age + poll ladder = module defaults (D5). No concurrency export (ADR-006).
      Cleanup options pass-through only (D2).
- [x] **Pre–Unit 5 — Minimal plugin SPI + registry.** Now under `src/plugins/`
      (`plugin.interface.ts`, `registry.ts`, `catalog.ts`). `DeviceMessagingPlugin` with
      nested `outgoing` / `incoming` / optional `token`; `Admission` declaration (ADR-006);
      one-shot `createPluginRegistry(config.plugins)` exported from `src/runtime.ts` with
      `config`. **Not** here: D1 owner map, D3 admission execution, D5 timeout move, real
      plugins.

### Phase 1b — Walking skeleton Intermezzo

**Why:** exerciseable contracts (config → stub plugin → HTTP → Redis) before more bottom-up
engine. Closed session 16 (I4 skipped). See decisions-log sessions 12–16.

- [x] **I0 — Docs pivot.** Plan / AGENTS / decisions-log course correction only.
- [x] **I1 — Boot + stub plugins.** `src/runtime.ts` loads config and builds
      `pluginRegistry` from `PLUGIN_CATALOG` (`stub-push` / `stub-pull` under
      `src/plugins/stub/`). Lookup-only registry; unknown / duplicate ids fail at boot.
      `config.default.json` stays empty; `config.example.json` lists both stubs.
- [x] **I2 — Thin HTTP.** Zod + routes for `POST /message/enqueue` and
      `GET /message/:correlationId` under `src/http/`; **camelCase wire** (ADR-003);
      Bearer when `DEVICE_MESSAGING_API_KEY` is set; in-memory store until I3; temporary
      `wire.ts` map to snake_case domain (deleted in I3). Plugin enablement once via
      `pluginRegistry.get`. Smoke: `src/http/smoke/` (httpYac). Not full Phase 3
      (no HMAC/DLQ/OpenAPI/ingress).
- [x] **I3 — Enqueue → Redis.** Thin `src/engine/outgoing.ts` (enqueue + get-by-correlation);
      plugin `bottleneckKey` → initial queue; distribute no-op. **Domain + Redis hash fields
      camelCase**; Redis **key paths** snake_case (`idx:correlation_id:`). Deleted `wire.ts` /
      in-memory store. Create DTO = Zod `createDeviceMessageSchema` in
      `lib/device-message/schemas.ts` → `CreateDeviceMessage` in `types.ts`; HTTP lean
      (maps `UnknownPluginError` → 400). Optional `correlationId` (no server ULID). Smoke +
      README Valkey-only compose. **Intermezzo HTTP↔Redis exit criterion met.**
- [x] **I4 — Skipped.** Maintainer closed Intermezzo without optional cancel / stub
      distribute tick (session 16). Cancel lands in Unit 5.2 with thin HTTP.

**Intermezzo closed.** HTTP↔Redis exit met in I3; I4 skipped. Resume Unit 5.2+.

### Phase 1 (engine resumed after 1b)

- [ ] **Unit 5 — Core engine, framework-stripped.** Sliced for review; **command/ingress
      faces land thin HTTP in the same chunk** (end-to-end rule):
      - [x] **5.1** Base — `src/engine/base.ts`: `retryOrFail`, `requeueMessage`,
        `emitDeliveryEvent` stub (no in-process pub/sub — ADR-003 webhook later).
        Requeue via `plugin.bottleneckKey` (not `queueInitial`).
        `BottleneckKeyInput` = `{ networkId, device }`; requeue uses `getMessageRawPropsById`.
      - [ ] **5.2** Cancel — engine cancel + thin `POST /message/cancel` /
        `POST /messages/cancel` + smoke (enqueue/get already from I3)
      - [ ] **5.3** D1 then distribute + D3 admission — timer-driven; exercise with stub
        plugins + enqueue/get (no public distribute route)
      - [ ] **5.4** sendOne + resolution cycle — same (internal; stubs + observe)
      - [ ] **5.5** Incoming + thin `POST /ingress/:pluginId` + smoke
      - [ ] **5.6** Token + thin `POST /token/generate` + interval timers (`engine.enabled`)
      `@Injectable`/`@Module` removed; timers gated on `engine.enabled` (ADR-002 §7).
      **ADR-006 / deferred:** D1–D3 in 5.3+; D2 on cleanup paths as wired; D5 when touching
      stage-timeout reads.
- [ ] **Unit 6 — Plugin SPI polish + config wiring.** Formalize anything still open on
      `DeviceMessagingPlugin` (command-type validation ADR-003 §4; optional tightening of
      PUSH/PULL incoming requirements). Construct only plugins present in config (ADR-002 §6) —
      **stub construction landed in I1**; Unit 6 adds real plugin factories to the same map.
      **D5 (ADR-002):** plugin `tuning` owns NS / GW / device / poll delays once Unit 5 can
      resolve via the registry — then drop those keys from core `delivery`. Stale sketch in
      `nxt-backend` plan 001 task 3.1 is detail only — correct `network_id` to `number | null`.
      *(Minimal SPI + registry already landed as pre–Unit 5.)*

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
| `lib/types.ts` | 175 | 1 | **ported** → `src/lib/types.ts` (core-only; see session 5) |
| *(new)* `lib/utils.ts` — vendors `generateRandomNumber`, `toSafeNumberOrNull` | — | 7–10 | **deferred** — adapter-only; lands with the plugin that needs each helper |
| `lib/redis-repository/index.ts` | 472 | 2 | **ported** → `src/lib/redis-repository/index.ts` |
| `lib/redis-repository/keys.ts` | 94 | 2 | **ported** → `src/lib/redis-repository/keys.ts` |
| `lib/redis-repository/helpers.ts` | 100 | 2 | **ported** → `src/lib/redis-repository/helpers.ts` |
| `../../queries/lua/device-messages/fetch-next-message-in-queue.lua` | 84 | 2 | **ported** → `src/lib/redis-repository/lua/fetch-next-message-in-queue.lua` |
| `../../queries/lua/device-messages/fetch-next-message-in-queue.types.ts` | 38 | 2 | **ported** → `src/lib/redis-repository/lua/fetch-next-message-in-queue.types.ts` |
| `../../queries/lua/device-messages/move-message-between-queues.lua` | 75 | 2 | **ported** → `src/lib/redis-repository/lua/move-message-between-queues.lua` |
| `../../queries/lua/device-messages/move-message-between-queues.types.ts` | 33 | 2 | **ported** → `src/lib/redis-repository/lua/move-message-between-queues.types.ts` |
| `lib/queue-moving.ts` | 185 | 3 | **ported** → `src/lib/queue-moving.ts` |
| `lib/queue-moving.push.ts` | 106 | 3 | **ported** → `src/lib/queue-moving.push.ts` |
| `lib/queue-moving.pull.ts` | 59 | 3 | **ported** → `src/lib/queue-moving.pull.ts` |
| `lib/retry-helpers.ts` | 45 | 3 | **ported** → `src/lib/retry-helpers.ts` |
| `lib/lifecycle.push.ts` | 82 | 4 | **ported** → `src/lib/lifecycle.push.ts` |
| `lib/lifecycle.pull.ts` | 138 | 4 | **ported** → `src/lib/lifecycle.pull.ts` |
| *(new)* `lib/plugin.interface.ts` | — | pre–5 | **ported** → `src/plugins/plugin.interface.ts` (moved from `lib/` post-I1) |
| *(new)* `lib/plugin-registry.ts` | — | pre–5 → I1 tidy | **ported** → `src/plugins/registry.ts` (one-shot from config; no mutable register) |
| *(new)* `plugins/catalog.ts` | — | I1 tidy | **ported** → `src/plugins/catalog.ts` |
| *(new)* `plugins/stub.ts` | — | I1 | **ported** → `src/plugins/stub/index.ts` (`stub-push` / `stub-pull`) |
| *(new)* `plugins/register-from-config.ts` | — | I1 | **dropped** — folded into `createPluginRegistry` |
| `device-messages.service.ts` | 140 | 5.1 | **ported** → `src/engine/base.ts` (no pub/sub; `emitDeliveryEvent` stub) |
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
| Debug HTTP to run distribute / poll once | Nice for manual stepping; not in ADR-003; overkill while timers + stubs suffice | Manual smoke against timers becomes painful |
| Domain vocabulary rename (`DeviceMessage` → dispatch-flavoured) | Would touch the Redis key schema and both Lua scripts during a behaviour-preserving move | Service is real and test-covered (ADR-001, Rejected) |
| HA / multi-instance (leader election, Redis-backed correlator) | `nxt-backend` ADR-010 §6 defers it | Evidence of multi-instance demand |

Cancel is **not** deferred — Unit **5.2** ships engine + `POST /message/cancel` /
`POST /messages/cancel`.

## Notes & decisions log

Deviations and per-unit notes go in `docs/decisions-log.md`, not here — one chronological record for
the whole effort.
