# Extraction Plan — device-messages → nxt-device-messaging

**Decisions:** ADR-001 (runtime), ADR-002 (config), ADR-003 (HTTP contract), ADR-004 (tooling),
ADR-005 (deployment / OSS hygiene), ADR-006 (bottleneck + admission), `nxt-backend` ADR-010 +
its 2026-07-27 amendment
**Plan number:** 001
**Created:** 2026-07-27
**Status:** Phase 0–3 done. Phase 4 sliced: **4.1 done**; **4.2A–B done**;
**next = 4.2C** (plugin `console.*`).

Supersedes `nxt-backend`'s `docs/plans/001-device-messaging-service-extraction.md`, which is marked
stale. That document is still useful as the **source of task detail** (retry semantics, queue stages,
plugin interface sketch) — but its phase order, framework assumptions, and several task descriptions
are wrong. Read `nxt-backend` ADR-010's amendment before using it. Phase 3 is **ADR-003 polish**
(webhook HMAC/DLQ, OpenAPI, auth); command/ingress routes land thin with the engine units that
need them (same pattern as Intermezzo enqueue/get).

---

## How to work in this plan

1. Read `AGENTS.md` (origin, baseline, governance) and `docs/decisions-log.md` first
   (settled vs open; **Parked / revisit**).
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
| **1** | Foundation: units 1–6 (SPI polish, D5/D6) | **Done** through Unit 6 |
| **1b** | **Walking skeleton Intermezzo** — stub plugins, thin HTTP, enqueue→Redis | **Closed** (I0–I3; I4 skipped) |
| **2** | Adapters as plugins: units 7–10 (`calin-api-v1`, `nxt-sts`, `calin-api-v2`, `calin-chirpstack`) | **Done** |
| **3** | ADR-003 **polish** (sliced): **3.1** webhook, **3.2** OpenAPI, **3.3** auth | **Done** |
| **4** | Deployment + hygiene: metrics, structured logging, integration guide, CI | **In progress** — **4.2B done**; **next 4.2C** |

Phase 0 is **done**. Phase 1 foundation through Unit **6** is **done**.
**Phase 1b is closed.** Phase 2 **Units 7–10** are **done**. **Phase 3 is closed**
(**3.1–3.3**). **Phase 4** in progress: **4.2B done**; next **4.2C**. Phase 4 still owns ADR-005 observability
hygiene (metrics, pino sweep, CONTRIBUTING/README) — CI/Docker stubs already in Phase 0.

### Phase 3 — ADR-003 polish (sliced)

Do **not** reopen 3.1 design in a 3.2 chat. Outbound webhook replaces in-process
`subscribe()` / `publish()`. Config key **`eventWebhook`** (was `resultWebhook`). Module
`src/engine/webhook/`. Full locks in ADR-003 §6 and decisions-log (sessions 32–36 + review
follow-ups).

- [x] **3.1A — Docs lock.** Shape: envelope, Redis keys, retry (~62s / 6 attempts),
      always-queue + drain kick, `eventWebhook` rename, HMAC deferred (H1). Schema key
      rename only (tuning fields → 3.1B).
- [x] **3.1B — Config tuning + Redis helpers.** `eventWebhook` knobs with defaults;
      `src/engine/webhook/` keys, types, backoff, store (no HTTP POST yet).
- [x] **3.1C — `createWebhookService`.** Build `WebhookEvent`, `storeAndEmit` + private
      drain + POST + retry/DLQ; claim lease; timer + kick. Public: `storeAndEmit` /
      `startTimers` only. Not wired into `baseService` / `main` yet (→ 3.1D).
      Requires `pluginId` (unsolicited call site fix in 3.1D).
- [x] **3.1D — Wire emit.** `baseService.emitDeliveryEvent` → `webhook.storeAndEmit`;
      `main` composes store/service/timers when `eventWebhook` set; unsolicited passes
      `pluginId`; opt-in Redis smoke.
- [x] **3.1E — HMAC.** Opt-in `DEVICE_MESSAGING_WEBHOOK_SECRET`; sign raw body; boot warn
      if URL without secret; `sign.ts` + verify helper.
      **Also landed in 3.1 review follow-ups:** await Redis enqueue before source cleanup;
      `requestTimeoutMs` + response body cancel; always send event-id header; lean
      SIGTERM/SIGINT shutdown; scoped smoke cleanup. **Parked:** shutdown v2 (await
      in-flight ticks); webhook drain concurrency.
- [x] **3.2 — OpenAPI** from Zod (ADR-001 §3 / ADR-003 §7). `/v3/api-docs` + `/swagger`
      (STS-mirrored); route schemas; outbound `webhooks.deliveryEvent` + `WebhookEvent`
      component (not a fake inbound path).
- [x] **3.3 — Auth / HTTP polish** (timing-safe Bearer, error bodies, …).
      - [x] **3.3A** Timing-safe Bearer on command routes (`src/http/auth.ts`);
            same `{ error: 'Unauthorized' }` for missing / malformed / wrong.
      - [x] **3.3B** Richer Zod validation error bodies (`{ error, issues: [{ path, message }] }`;
            domain/auth errors omit `issues`).

### Phase 4 — ADR-005 observability / hygiene (sliced)

Docker/CI/`GET /healthz` already landed in Phase 0. Do **not** pull parked items
(see `docs/decisions-log.md` § Parked / revisit).

- [x] **4.1 — `GET /metrics`** (`prom-client`; unauthenticated; Redis only on scrape
      for queue depth). Co-located under `src/metrics/`.
      - [x] **4.1A** Isolated registry + route; `device_messaging_up`. No engine
            increments, no Redis scrape.
      - [x] **4.1B** In-process counters / histogram (terminals, retries, webhook,
            unhandled ingress).
      - [x] **4.1C** Queue-depth gauges (ZCARD known stages + `queues_to_distribute_from`
            members; pipeline; scrape-time only).
- [ ] **4.2 — Pino** (one logger; pretty stdout default; JSON opt-in; sinks deferred).
      - [x] **4.2A** Factory + `logging.stdout` in the artifact; Fastify + `main` boot/shutdown.
      - [x] **4.2B** Engine / `lib` `console.*` → `logger` + `module` field.
      - [ ] **4.2C** Plugin `console.*` → `logger` + `module` field.
- [ ] **4.3 — Docs** (`CONTRIBUTING.md`, issue templates, README deploy/health dual-path,
      integration guide: webhook verify + event set).

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
      `idx:correlation_id:`. **Per ADR-006:** omit `queueInitial` (plugins own `initialQueueKey`);
      `queueAwaitingTask(pluginId)`; `messageFullCleanup` takes `inFlightQueueKeys` (interim —
      see ADR-006 D2). No admission engine and no `queueKey → pluginId` map yet (D1/D3).
- [x] **Unit 3 — Queue primitives.** `queue-moving{,.push,.pull}.ts`, `retry-helpers.ts`.
      Hardcoded timeout/retry constants → `delivery.*` passed into helpers (ADR-002 §5).
      **Interim:** stage timeouts on `delivery` — end state is plugin `tuning` (**D5**).
      PULL `fromNsToAwaitingTask` takes `pluginId` (not `NetworkServerImplementation`).
      `fromAnyToRetry` optional `concurrencyRateLimitKey` (ADR-006; mirrors Unit 2 cleanup).
      No distribute admission / `initialQueueKey` wiring here.
- [x] **Unit 4 — Lifecycle.** `lifecycle.push.ts`, `lifecycle.pull.ts`.
      PUSH: `getPushTimeouts` / `maybeExtendMessageInRelayNodeQueue`. PULL:
      `pollAwaitingTasksFor(plugin)` / `getPullTimeouts(now, pluginIds)` — no hardcoded
      PULL ids. Interim facets deleted in Unit 6 (`DeviceMessagingPlugin`).
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
      plugin `initialQueueKey` → initial queue; distribute no-op. **Domain + Redis hash fields
      camelCase**; Redis **key paths** snake_case (`idx:correlation_id:`). Deleted `wire.ts` /
      in-memory store. Create DTO = Zod `createDeviceMessageSchema` in
      `lib/device-message/schemas.ts` → `CreateDeviceMessage` in `types.ts`; HTTP lean
      (maps `UnknownPluginError` → 400). Optional `correlationId` (no server ULID). Smoke +
      README Valkey-only compose. **Intermezzo HTTP↔Redis exit criterion met.**
- [x] **I4 — Skipped.** Maintainer closed Intermezzo without optional cancel / stub
      distribute tick (session 16). Cancel lands in Unit 5.2 with thin HTTP.

**Intermezzo closed.** HTTP↔Redis exit met in I3; I4 skipped. Resume Unit 5.2+.

### Phase 1 (engine resumed after 1b)

- [x] **Unit 5 — Core engine, framework-stripped.** Sliced for review; **command/ingress
      faces land thin HTTP in the same chunk** (end-to-end rule):
      - [x] **5.1** Base — `src/engine/base.ts`: `retryOrFail`, `requeueMessage`,
        `emitDeliveryEvent` stub (no in-process pub/sub — ADR-003 webhook later).
        Requeue via `plugin.initialQueueKey` (not `queueInitial`).
        `InitialQueueKeyInput` = `{ networkId, device }`; requeue uses `getMessageRawPropsById`.
      - [x] **5.2** Cancel — engine cancel + thin `POST /message/cancel` /
        `POST /messages/cancel` + smoke (enqueue/get already from I3)
      - [x] **5.3** `distributeToNetworkServers` + D3 admission on `createOutgoingService`
        (timer wiring deferred to 5.6; exercise via stubs + one tick; no public route).
        **D1 (18b):** `buildInitialQueueKey` → `queue:{pluginId}:{kind}:{id}`.
        **D3 (19):** named spacing/concurrency/custom; enqueue fire-and-forget kick;
        concurrency rate-limit key derived via `buildConcurrencyRateLimitKey` (no SPI
        builder); stop before `sendOne`.
      - [x] **5.4** sendOne + post-send PUSH|PULL moves (internal; stubs + smoke poll).
        Fire-and-forget after pick. `createBaseService` peer at composition root;
        `retryOrFail` gets `concurrencyRateLimitKey` when admission is concurrency
        (message → `initialQueueKey` → `buildConcurrencyRateLimitKey`).
      - [x] **5.5** Incoming + thin `POST /ingress/:pluginId` + smoke.
        `createIncomingService` peer shares `baseService`; HTTP resolves plugin once →
        `handle(event, plugin)`. `pollPullPlugins` as callable tick; timers deferred to 5.6.
      - [x] **5.6** Token + thin `POST /token/generate` + interval timers (`engine.enabled`).
        `createTokenService`; `runMessageResolutionCycle` on outgoing; `startEngineTimers`
        (2s resolution / 5s poll). Engine facades named `*Service`.
      **ADR-006 / deferred:** D1+D3 done in 5.3; send-fail concurrency key in 5.4; D2 on
      remaining cleanup paths (incoming success not yet); D5 done in Unit 6.
- [x] **Unit 6 — Plugin SPI polish + config wiring.**
      - Service-owned `CommandType` / `ENQUEUEABLE_COMMAND_TYPES` / `GENERATE_TOKEN_TYPES`
        (`TOP_UP_KWH`); plugin `supportedCommandTypes`; enqueue gate + 400.
      - Token body Zod-inferred (`GenerateTokenRequest`); deleted hand SPI token type.
      - Unit 4 interim facets deleted (`DeviceMessagingPlugin` in lifecycle).
      - PUSH/PULL discriminant / boot-assert **skipped** (no downstream-check win).
      - **D6:** wire `device.relayNode` (was `gateway`); stub PULL `kind` = `relayNode`.
      - **D5:** `PluginTuning` on SPI; queue-moving reads tuning; `delivery` = retry/TTL only.
        Redis mid stage `queue_in_flight_to_relay_node`; stubs `mergeStubTuning` from config.
      - Catalog still stubs-only; Units 7–10 add real factories to the same map
        (order: v1 → nxt-sts → v2 → chirpstack — session 26b).

### Phase 2 — adapters as plugins

Order amended sessions 24–24b / **26b**: **PULL first** (`calin-api-v1`) for controllable
vendor-API testing; **`nxt-sts`** so token mint is testable; **`calin-api-v2` before
ChirpStack** (second HTTP CALIN variant, easier after v1); `calin-chirpstack` last.

- [x] **Unit 7 — `calin-api-v1`** (~726 lines). Actively supported; V1 meters are in the field.
      First real adapter — validates the plugin SPI (`nxt-backend` ADR-001) under PULL
      (outgoing create-task + poll). Source: `adapters/calin-api-v1/`
      (`_outgoing`, `_incoming`, `_token`, `lib/repo`). Landed 7.0–7.6 (session 25).
- [x] **Unit 8 — `nxt-sts` token plugin** (46 lines). `HttpService` → native `fetch`.
      Needed before ChirpStack so token-generate / deliver-token paths can be exercised.
      Also lands `generateRandomNumber` + shared `requireEnvKeys`. Landed session 26.
- [x] **Unit 9 — `calin-api-v2`** (~500 lines). Second HTTP CALIN PULL variant; port after v1.
      Source: `adapters/calin-api-v2/` (`_outgoing`, `_incoming`, `_token`, `lib/repo`).
      Landed 9.1–9.6 (session 27); v2/v1 polish (session 28 — see decisions log).
- [x] **Unit 10 — `calin-chirpstack`** (~1,200 lines). Source folder was
      `adapters/calin-lorawan/` in `legacy/`; destination plugin id/folder is `calin-chirpstack`
      (ADR-003 §3). `_incoming`, `_outgoing`, `lib/{types, encode-request-data,
      decode-response-data, correlate-request-response, connectivity-helpers}`, plus
      `lib/chirpstack-repository/` → `src/plugins/_shared/chirpstack-repository/` (shared
      plugin-tier client; `CHIRPSTACK_*`). `initialQueueKey` handles `unassigned`.
      Landed 10.1–10.6 (session 29); D4 `kind` = `network`.

## Import ledger

Every source file in scope. Status: `pending` / `ported` / `dropped` / `deferred`.
Paths are relative to `legacy/apps/tiamat/src/modules/device-messages/` unless noted.

| Source file | Lines | Unit | Status |
|---|---|---|---|
| `lib/types.ts` | 175 | 1 | **ported** → `src/lib/types.ts` (core-only; see session 5) |
| *(new)* `lib/utils.ts` — vendors `generateRandomNumber`, `toSafeNumberOrNull` | — | 7–8 | **ported** → `_shared/to-safe-number-or-null.ts` (Unit 7.2) + `_shared/generate-random-number.ts` (Unit 8.2); also `_shared/require-env-keys.ts` (Unit 8) |
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
| `outgoing.service.ts` | 354 | 5 | **ported** → `src/engine/outgoing.ts` (+ resolution cycle; timers in `timers.ts`) |
| `incoming.service.ts` | 163 | 5.5 | **ported** → `src/engine/incoming.ts` (+ thin `src/http/ingress-routes.ts`) |
| `token.service.ts` | 36 | 5.6 | **ported** → `src/engine/token.ts` (+ thin `src/http/token-routes.ts`) |
| `dto/create-device-message.dto.ts` | 25 | I3 / 5 | **ported** → `src/lib/device-message/schemas.ts` (`createDeviceMessageSchema`) |
| `dto/generate-token.dto.ts` | 17 | 5.6 | **ported** → `src/lib/device-message/schemas.ts` (`generateTokenSchema`; Unit 7.5: `type`-discriminated payload) |
| `device-messages.module.ts` | 37 | 5 | **dropped** — superseded by the composition root (ADR-001 §2) |
| `adapters/calin-api-v1/_outgoing.service.ts` | 222 | 7 | **ported** → `src/plugins/calin-api-v1/outgoing.ts` (Unit 7.3) |
| `adapters/calin-api-v1/_incoming.service.ts` | 274 | 7 | **ported** → `src/plugins/calin-api-v1/incoming.ts` (Unit 7.4; camelCase `response.data`) |
| `adapters/calin-api-v1/_token.service.ts` | 97 | 7 | **ported** → `src/plugins/calin-api-v1/token.ts` (Unit 7.5; `TOP_UP_KWH`) |
| `adapters/calin-api-v1/lib/repo.ts` | 133 | 7 | **ported** → `src/plugins/calin-api-v1/lib/repo.ts` (fetch; Unit 7.2) |
| `adapters/nxt-sts/_token.service.ts` | 46 | 8 | **ported** → `src/plugins/nxt-sts/` (`token.ts` + `lib/repo.ts` fetch; Unit 8) |
| `adapters/calin-api-v2/_outgoing.service.ts` | 196 | 9 | **ported** → `src/plugins/calin-api-v2/outgoing.ts` (Unit 9.3) |
| `adapters/calin-api-v2/_incoming.service.ts` | 198 | 9 | **ported** → `src/plugins/calin-api-v2/incoming.ts` (Unit 9.4; camelCase `response.data`) |
| `adapters/calin-api-v2/_token.service.ts` | 82 | 9 | **ported** → `src/plugins/calin-api-v2/token.ts` (Unit 9.5; `TOP_UP_KWH`; `crypto.randomUUID`) |
| `adapters/calin-api-v2/lib/repo.ts` | 212 | 9 | **ported** → `src/plugins/calin-api-v2/lib/repo.ts` (fetch + login cache; Unit 9.2) — **see coupling note below** |
| `adapters/calin-lorawan/_outgoing.service.ts` → plugin `calin-chirpstack` | 77 | 10 | **ported** → `src/plugins/calin-chirpstack/outgoing.ts` (Unit 10.4; `CalinChirpstackError` + `skipRetry`) |
| `adapters/calin-lorawan/_incoming.service.ts` → plugin `calin-chirpstack` | 135 | 10 | **ported** → `src/plugins/calin-chirpstack/incoming.ts` (Unit 10.5; camelCase; `relayNode`) |
| `adapters/calin-lorawan/lib/types.ts` → plugin `calin-chirpstack` | 86 | 10 | **ported** → `src/plugins/calin-chirpstack/lib/types.ts` (Unit 10.3) |
| `adapters/calin-lorawan/lib/encode-request-data.ts` → plugin `calin-chirpstack` | 360 | 10 | **ported** → `src/plugins/calin-chirpstack/lib/encode-request-data.ts` (Unit 10.3; `isTokenCommand` / `TOP_UP_KWH`) |
| `adapters/calin-lorawan/lib/decode-response-data.ts` → plugin `calin-chirpstack` | 422 | 10 | **ported** → `src/plugins/calin-chirpstack/lib/decode-response-data.ts` (Unit 10.3; camelCase `response.data`) |
| `adapters/calin-lorawan/lib/correlate-request-response.ts` → plugin `calin-chirpstack` | 113 | 10 | **ported** → `src/plugins/calin-chirpstack/lib/correlate-request-response.ts` (Unit 10.3; TTL GC + `unref`) |
| `adapters/calin-lorawan/lib/connectivity-helpers.ts` → plugin `calin-chirpstack` | 20 | 10 | **ported** → `src/plugins/calin-chirpstack/lib/connectivity-helpers.ts` (Unit 10.3; → `RelayNodeInfo`) |
| `lib/chirpstack-repository/index.ts` → `_shared/chirpstack-repository` | 109 | 10 | **ported** → `src/plugins/_shared/chirpstack-repository/` (Unit 10.2; secrets + gRPC client) — **see coupling note below** |
| `adapters/calin-lorawan/lib/_UNUSED_EXAMPLE_correlate-request-response.redis.ts` | 138 | — | **dropped** — dead code |

### Coupling note — vendor clients shared with `meter-installs`

Two files in this ledger have consumers **outside** device-messages that stay in `nxt-backend`:

- `lib/chirpstack-repository/index.ts` (now `src/plugins/_shared/chirpstack-repository/`) —
  `meter-installs/adapters/calin-lorawan/_install.service.ts` uses `registerDevice()` and
  `setApplicationKeyForDevice()`.
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

**Canonical living list:** `docs/decisions-log.md` § **Parked / revisit**.
Do not add rows here — they drift from the log. HA remains governed by **ADR-007**.

Cancel is **not** deferred — Unit **5.2** ships engine + `POST /message/cancel` /
`POST /messages/cancel`.

## Notes & decisions log

Deviations and per-unit notes go in `docs/decisions-log.md`, not here — one chronological record for
the whole effort.
