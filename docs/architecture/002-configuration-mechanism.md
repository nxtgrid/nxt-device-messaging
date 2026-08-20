# ADR-002: Configuration Mechanism

**Date:** 2026-07-27
**Status:** Accepted

> Adopts `nxt-backend` ADR-007's mechanism with recorded adaptations (see "Deviations from
> `nxt-backend` ADR-007"). `nxt-backend` ADR-007 decision 6 explicitly anticipated this:
> *"When a capability (e.g. `device-messages`) is later extracted into its own service, that
> config section travels with it."*
>
> **Amendment (2026-07-29):** Stage timeouts on shared `delivery.*` are an **interim** from
> Phase 1 Unit 3 — see decision **D5** in `docs/decisions-log.md` and §5 below. End state:
> only cross-plugin knobs stay on `delivery`; stage / poll delays live in plugin `tuning`.
>
> **Amendment (2026-07-30):** Access is via `src/runtime.ts` boot exports (`config`,
> `pluginRegistry`), not `getConfig()` / `setConfig()`. See §4.
>
> **Amendment (2026-08-04):** D5 **names locked and implemented** (Unit 6.2) —
> `nsInFlightTimeoutMs`, `relayNodeInFlightTimeoutMs`, `deviceInFlightTimeoutMs`,
> `initialPollDelayMs` on `plugin.tuning`. PUSH mid-stage Redis key →
> `queue_in_flight_to_relay_node` (was `…_to_gw`). Shared `delivery` is retry/TTL only.
>
> **Amendment (2026-08-10):** Config key rename `resultWebhook` → **`eventWebhook`**
> (outbound delivery **events**, not terminal-only). Retry/DLQ tuning under that object
> (defaults locked session 32; schema fields session 33) — see ADR-003 §6.
>
> **Amendment (2026-08-14):** Root object **`logging`** (`stdout`: `"pretty"` | `"json"`,
> default pretty). Extra sinks deferred. Secrets for a future sink stay in env. See ADR-005 §7.
>
> **Amendment (2026-08-20):** C3 — `tuning` is a delivery-plugin field (`PushPlugin` /
> `PullPlugin`). Token-only plugins (`deliveryPattern: 'NONE'`) have none. D5's four names
> are unchanged.

---

## Context

The service must be easily deployable and highly configurable by operators who cannot fork it —
which adapters run, how they reach their vendor APIs, and how aggressively delivery is retried.
The module as inherited is neither.

### What the inherited module does today

**25 environment variables, read across 13 sites, most at import time:**

| Group | Variables |
|---|---|
| Runtime | `NXT_ENV` |
| Redis | `HERMES_HOST`, `HERMES_PORT`, `HERMES_USERNAME`, `HERMES_PASSWORD` |
| calin-chirpstack (ChirpStack gRPC client in `_shared/chirpstack-repository/`) | Vendor-scoped **`CHIRPSTACK_*`** (Unit 10; not plugin-id-prefixed): `CHIRPSTACK_API_URL`, `CHIRPSTACK_API_TOKEN`, `CHIRPSTACK_APPLICATION_ID`, `CHIRPSTACK_PROFILE_ID`, `CHIRPSTACK_APP_KEY` |
| calin-api-v1 | Legacy `CALIN_V1_*` → **this service** `CALIN_API_V1_*` (plugin-id aligned; Unit 7): `CALIN_API_V1_URL`, `CALIN_API_V1_COMPANY_NAME`, `CALIN_API_V1_ADMIN_USERNAME`, `CALIN_API_V1_ADMIN_PASSWORD`, `CALIN_API_V1_POS_USERNAME`, `CALIN_API_V1_POS_PASSWORD`, `CALIN_API_V1_MAINTENANCE_USERNAME`, `CALIN_API_V1_MAINTENANCE_PASSWORD` |
| calin-api-v2 | Legacy `CALIN_V2_*` → **this service** `CALIN_API_V2_*` (plugin-id aligned; Unit 9): `CALIN_API_V2_URL` (was `CALIN_V2_API`), `CALIN_API_V2_COMPANY_NAME`, `CALIN_API_V2_CUSTOMER_ID`, `CALIN_API_V2_ADMIN_USERNAME`, `CALIN_API_V2_ADMIN_PASSWORD` (was `CALIN_V2_PASSWORD`), `CALIN_API_V2_POS_PASSWORD` |
| nxt-sts | Legacy `STS_GENERATOR_API` → **this service** `NXT_STS_URL` (plugin-id aligned; Unit 8) |

**And ~14 hardcoded tuning constants that no operator can change without editing code:**

| Constant | Value | Lives in | Scope |
|---|---|---|---|
| `CONFIG_QUEUE_NS.PROCESSING_TIMEOUT_MS` | 20s | `lib/queue-moving.ts` | shared, but wants to be per-plugin |
| `CONFIG_QUEUE_GW.PROCESSING_TIMEOUT_MS` | 15min | `lib/queue-moving.push.ts` | push |
| `CONFIG_QUEUE_DEVICE.PROCESSING_TIMEOUT_MS` | 12s | `lib/queue-moving.push.ts` | push |
| `CONFIG_QUEUE_AWAITING_TASK.INITIAL_POLL_DELAY_MS` | 10s | `lib/queue-moving.pull.ts` | pull |
| `PULL_MAX_CONCURRENT_PER_GATEWAY` | 5 | `lib/lifecycle.pull.ts` (legacy export; **not** ported to Unit 4 — ADR-006 admission) | pull |
| `PULL_PATTERN_MAX_MESSAGE_AGE_MS` | 48h | `lib/lifecycle.pull.ts` (ported as Unit 4 module default; D5 → plugin `tuning`) | pull |
| `LORAWAN_FLOOD_PREVENTION_WINDOW_MS` | 2s | `outgoing.service.ts` | plugin-specific, in a shared file |
| `MAX_RETRIES` / base / multiplier / cap | 11 / 2s / ×2 / 1h | `lib/retry-helpers.ts` | shared |
| `MESSAGE_TTL_SECONDS` | 7 days | `lib/redis-repository/index.ts` | shared |
| `CORRELATION_TTL_MS`, `GC_INTERVAL_MS` | 10s, 30s | `calin-chirpstack` correlator | plugin-internal |
| `CUSTOM_LOGIN_TIMEOUT_MS`, `FETCH_RETRIES` | 5s, 3 | calin-api-v2 repo | plugin-internal |

Three of those knobs are pattern- or plugin-specific yet live in shared pipeline files. That is
exactly the friction `nxt-backend` ADR-001 recorded — *"NS timeout is a single value, but LoRaWAN
needs ~10s and CALIN API needs ~30s"* — and whose recommended fix (adapters declaring
`maxConcurrentRequests`, `nsTimeoutMs`, `rateLimitScope`) was never implemented. Configuration and
the plugin contract are therefore the same problem seen from two sides.

### Why not flat 12-factor environment variables

Flat env is the obvious default for a single-purpose service, and it was seriously considered. It
fails on the service's central product goal — *adding a hardware integration is one file, no core
changes*:

- The core would have to know every plugin's variable names in order to validate them, which
  breaks the goal outright; **or**
- each plugin reaches into `process.env` itself — which is what the code does today, and precisely
  what the extraction is meant to eliminate.

The tuning surface compounds it: knobs are per-plugin × per-knob, so flat env goes combinatorial
(`CALIN_API_V1_NS_TIMEOUT_MS`, `CALIN_LORAWAN_NS_TIMEOUT_MS`, `CALIN_API_V1_MAX_CONCURRENT`, …).

## Decisions

### 1. A JSON config artifact carries topology, non-secret settings, and tuning

One JSON artifact fully describes a deployment's shape. It is **non-sensitive** by construction and
therefore safe to inline in an environment variable, serve from object storage, or bind-mount.

```jsonc
{
  "$schemaVersion": "1",
  "engine": { "enabled": true },
  "logging": { "stdout": "pretty" },
  "delivery": {                          // shared engine knobs, all optional
    "maxRetries": 11,
    "retryBaseDelayMs": 2000,
    "retryBackoffMultiplier": 2,
    "retryMaxDelayMs": 3600000,
    "messageTtlSeconds": 604800
  },
  "eventWebhook": {
    "url": "https://consumer.example/hooks/device-messages",
    "maxAttempts": 6,
    "baseDelayMs": 2000,
    "backoffMultiplier": 2,
    "maxDelayMs": 60000,
    "requestTimeoutMs": 10000,
    "deadLetterTtlSeconds": 604800
  },
  "plugins": [
    { "id": "calin-chirpstack",
      "settings": { "chirpstackUrl": "…", "applicationId": "…", "profileId": "…" },
      "tuning":   { "nsInFlightTimeoutMs": 10000 } },
    { "id": "calin-api-v2",
      "settings": { "baseUrl": "…", "companyName": "…", "customerId": "…" },
      "tuning":   { "nsInFlightTimeoutMs": 30000 } }
  ]
}
```

`$schemaVersion` is validated at boot; a mismatch is rejected with a clear error.

### 2. Secrets stay in environment variables, never in the artifact

Credentials, API tokens, and the Redis connection remain environment-supplied, keyed by a
per-plugin naming convention that matches the plugin id when practical
(`CALIN_API_V1_ADMIN_PASSWORD` for `calin-api-v1`, `CHIRPSTACK_API_TOKEN`, … — legacy tiamat
used shorter `CALIN_V1_*` / `CALIN_V2_*` prefixes). Each plugin **declares the environment
keys it needs, co-located with the plugin**, and validates them at its own registration
point — `nxt-backend` ADR-007 decision 9's two-layer model, unchanged.

The event-webhook signing secret and the inbound API key are secrets and therefore env-supplied,
while the webhook *URL* is topology and lives in the artifact.

### 3. Plugins contribute their own Zod schemas, composed into the root schema

The contract is a **Zod** schema. A plugin exports Zod schemas for its own `settings` and `tuning`
blocks, and the core composes the schemas of *registered* plugins into the root schema before
parsing. Validation of a plugin's configuration therefore arrives with the plugin, and no core file
changes when a plugin is added.

This is the mechanism that makes the single-file-plugin goal include the configuration contract,
and it is the primary reason a JSON artifact was chosen over flat env.

### 4. Resolution, validation, and access

Resolution follows `nxt-backend` ADR-007 decision 4's precedence, with service-local names:

**`DEVICE_MESSAGING_CONFIG_JSON` (inline) → `DEVICE_MESSAGING_CONFIG_URL` (fetch) →
`DEVICE_MESSAGING_CONFIG_PATH` (file) → bundled `config.default.json`.**

At startup (`src/runtime.ts`, top-level await): **resolve → `JSON.parse` → Zod `.parse()` →
`Object.freeze` → export `config`**. The same module builds `pluginRegistry` from
`config.plugins`. Call sites `import { config, pluginRegistry } from '../runtime.js'` and may
bind values at module top level.

**Import rule:** only composition / engine / HTTP import `runtime`. `lib/` helpers take the
slices they need as arguments (e.g. `delivery`) so unit tests never pull boot I/O.

`loadConfig()` remains a pure async function (returns the frozen config; no process-wide store).
Tests of resolution call `loadConfig({ defaultConfigPath })` directly; tests of plugins call
`createPluginRegistry([...])` without importing `runtime`.

There is no DI container to inject a config service into (ADR-001 decision 2), so a frozen
module-level binding from the boot module is the right primitive here — `nxt-backend` ADR-007's
original justification applies with more force, not less.

The repo ships the Zod schema, a documented `config.example.json`, and a minimal
`config.default.json` that boots with no plugins enabled.

### 5. Tuning layers: plugin defaults in code, config overrides per deployment

Each plugin declares its own default tuning values **in code** — the shape `nxt-backend` ADR-001
recommended. The config artifact *overrides* them. Every value under `tuning` is therefore
optional, and an operator who does not care writes nothing.

This keeps the vendor knowledge (that CALIN needs ~30s and LoRaWAN ~10s) in the plugin that knows
it, while leaving an operator free to tune for their own network.

**Shared `delivery.*` vs plugin `tuning` (D5, locked 2026-07-29; names locked 2026-08-04):**

| Stays on `delivery` (cross-plugin) | On `plugin.tuning` (Unit 6.2) |
|---|---|
| `maxRetries`, retry backoff knobs, `messageTtlSeconds` | `nsInFlightTimeoutMs` → `queue_in_flight_to_ns` |
| | `relayNodeInFlightTimeoutMs` → `queue_in_flight_to_relay_node` (PUSH mid stage; was `gw*`) |
| | `deviceInFlightTimeoutMs` → `queue_in_flight_to_device` (end meter) |
| | `initialPollDelayMs` → first PULL poll |

PULL max-age / poll-delay ladder stay module defaults until a real PULL plugin needs them.
Concurrency caps stay on `admission` (ADR-006), not `tuning`.

Unit 3 put stage timeouts on `delivery` before a registry existed. Unit 6.2 moves them to
plugin `tuning` (defaults in code, config override) and drops those keys from core
`delivery`. Queue helpers take knobs as arguments; they do not import `runtime`.

### 6. Honesty rules — fail fast, but degrade gracefully at runtime

Mapping `nxt-backend` ADR-007 decision 8 onto plugins:

| Situation | Behaviour |
|---|---|
| Plugin absent from config | Never constructed. Not registered, not polled, not routable |
| Plugin listed, but its declared env is missing | **Boot fails** with a clear `MISSING …` naming the plugin and the key |
| A message arrives for a plugin that is not enabled | That **message** fails with a clear reason; the service does not crash |
| Optional integration absent | Silently skipped |

The third row matters: routing is data-driven (a message names its device's manufacturer and
protocol), so a message can legitimately arrive for a plugin this deployment does not run. Config
constrains the route map; it does not make unknown input fatal.

### 7. `engine.enabled` replaces environment-name gating

Both cron jobs are currently gated on `process.env.NXT_ENV !== 'production'`, which means the
entire delivery engine is **inert outside production** — messages enqueue and nothing ever moves
them. For a service whose quick start promises `docker-compose up`, that is fatal.

Replaced by an explicit `engine.enabled` config flag, **defaulting to on**. An operator who wants
an ingest-only or inspection-only instance sets it to `false` deliberately.

This is a deliberate behaviour change from the inherited module, not a port.

### 8. `REDIS_*` replaces `HERMES_*`

The Redis connection variables are renamed from `HERMES_*` to `REDIS_HOST`, `REDIS_PORT`,
`REDIS_USERNAME`, `REDIS_PASSWORD`, `REDIS_TLS`, `REDIS_DB`. `HERMES` is an internal
instance name and has no meaning to an adopter.

## Deviations from `nxt-backend` ADR-007

| ADR-007 element | Here | Why |
|---|---|---|
| `NXT_CONFIG_JSON` / `_URL` / `_PATH` | `DEVICE_MESSAGING_CONFIG_*` | Standalone service should not inherit NXT branding in its env contract |
| `capabilities` / `integrations` subtrees | `plugins` array, `engine`, `delivery` | Different domain; there are no capability flags here, only plugins |
| `public` presentation subtree | Omitted | No browser consumer; nothing to expose |
| Adapter list "constrains a data-driven route map" | Same, made explicit as decision 6 | Was implied in ADR-007 decision 6; stated as behaviour here |
| Central Zod schema owns all adapter shapes | Plugin-contributed schemas composed at registration | Required by the single-file-plugin goal |
| Tuning not addressed | Plugin defaults in code, config overrides | Implements `nxt-backend` ADR-001's unimplemented recommendation |

## Consequences

### Positive

- An operator configures the whole service from one JSON artifact plus secrets, with clear boot
  errors naming the plugin and key at fault.
- Adding a plugin adds its configuration contract in the same file — no core edits.
- `nxt-backend` ADR-001's per-adapter timeout and concurrency problem gets a home instead of
  remaining an unimplemented recommendation.
- Every `process.env` read leaves the domain code; the composition root and plugin registration
  are the only places environment is touched.
- The artifact is non-secret, so it is safe to inline on a platform with no volume mounts.

### Negative / Risks

- Two configuration surfaces (artifact and env) means an operator must understand the split. The
  rule is simple — secrets in env, everything else in the artifact — but it is a rule to learn.
- Boot exports (`config` / `pluginRegistry`) are less pure than full parameter injection;
  mitigated by keeping `lib/` free of `runtime` and injecting slices into helpers.
- Boot stops at the first misconfigured plugin rather than reporting all of them. Accepted;
  aggregation is a future nicety.
- Composing plugin schemas at runtime means the root config type is not fully static. The inferred
  type covers the core; plugin blocks are typed by their own schemas.
- `DEVICE_MESSAGING_CONFIG_URL` introduces a boot-time network dependency when used.

## Triggers (revisit when)

- A deployment needs per-organization or per-tenant plugin configuration rather than
  per-deployment (this model is per-deployment, matching `nxt-backend` ADR-004).
- Plugins need configuration that changes at runtime rather than at boot.
- The plugin count grows enough that the flat `plugins` array wants grouping by pattern.
- An operator asks for an aggregated list of all missing configuration instead of first-failure.

## Related

- **ADR-001** — Fastify + Zod, no DI container; why a frozen global is the right primitive.
- **ADR-003** — public HTTP contract; plugin ids (`calin-chirpstack`, …) and `eventWebhook` usage.
- **`nxt-backend` ADR-007** — the mechanism this adapts; decision 6 anticipated this extraction.
- **`nxt-backend` ADR-001** — PUSH/PULL divergence; the per-adapter tuning this implements.
- **`nxt-backend` ADR-010** — the extraction decision; its plugin contract carries the tuning.
