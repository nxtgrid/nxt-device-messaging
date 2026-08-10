# ADR-003: Public HTTP Contract

**Date:** 2026-07-27
**Status:** Accepted — amended 2026-07-30 (command API + domain + Redis hash fields =
camelCase; Redis key paths + Lua locals = snake_case); amended 2026-08-03 (Unit 6.1:
service-owned `CommandType` vocabulary + plugin `supportedCommandTypes` subset);
amended 2026-08-04 (D6: `device.relayNode` replaces `device.gateway`);
amended 2026-08-08 (`calin-chirpstack` ingress `?event=` routing — fail closed);
amended 2026-08-10 (Phase 3.1A: `eventWebhook` rename; retry/DLQ/schedule/keys locked;
HMAC deferred to a later chunk)

> Normative consumer contract for this service. Supersedes the incomplete endpoint inventory in
> `nxt-backend` ADR-010 decision 2 (and its 2026-07-27 amendment §§C–D) for everything that lives
> on *this* side of the wire. `nxt-backend` still owns why the extraction happened and how
> `meter-interactions` rewires onto this API.

---

## Context

The inherited module has no HTTP surface of its own. Five in-process call sites in
`meter-interactions` / ChirpStack wiring become the public contract:

| Today (in-process) | Becomes |
|---|---|
| `enqueue()` | Command API — enqueue |
| `getMessageByMeterInteractionId()` | Command API — inspect |
| `cancelOne` / `cancelMany` (zero callers, logic present) | Command API — cancel |
| `deviceTokenService.generate()` | Command API — sync token (missing from ADR-010) |
| `incoming.handle()` via `POST /chirpstack/calin` | Ingress |
| `subscribe()` / `publish()` | Outbound event webhook |

`nxt-backend` ADR-010 calls the outbound webhook "the single most consequential interface
decision." The only production consumer will be imported `meter-interactions` in `apps/api`,
but the contract must also be adoptable by third parties. Configuration already anticipates
this: ADR-002 puts `eventWebhook.url` in the JSON artifact and the signing secret in env.

Source baseline: `db5c2ac`. Cancel was deferred in planning because it had zero callers, not
because the logic was missing — both single and batch cancel already exist in Redis.

---

## Decisions

### 1. Action-oriented paths; singular vs plural encodes cardinality

| Method + path | Role |
|---|---|
| `POST /message/enqueue` | Enqueue one command |
| `GET /message/:correlationId` | Inspect delivery state for one correlation id |
| `POST /message/cancel` | Cancel one (`{ correlationId }`) |
| `POST /messages/cancel` | Cancel many (`{ correlationIds: string[] }`) |
| `POST /token/generate` | Mint one token synchronously |
| `POST /ingress/:pluginId` | Vendor → service webhook (raw body) |

Cancel uses POST (not DELETE) so single and batch share one verb family and carry ids in the
body. Soft-document an upper bound on batch size (on the order of hundreds); the port may
MGET-optimise lookups for large batches. Message-bus delivery remains **deferred**.

### 2. Field vocabulary (names) and wire casing

**Vocabulary** (same words HTTP ↔ Redis ↔ logs — not a Postgres constraint):

| Inherited | Here |
|---|---|
| `meter_interaction_id` | `correlationId` (opaque string, caller-supplied) |
| `grid_id` | `networkId` (`number \| null`; null → LoRaWAN `unassigned` bucket) |
| `message_type` | `commandType` (service-owned closed set; see decision 4) |

Aligns with `nxt-backend` ADR-010 decision 4 and with estate vocabulary in ADR-011
(`command_type` on `meter_command_batches` — that column name stays on the estate DB).

**Wire JSON, in-process domain types, and Redis hash fields are camelCase**
(`correlationId`, `commandType`, `networkId`, `externalReference`, `deliveryStatus`, …).
Path params match (`:correlationId`).

**Redis key paths and Lua locals are snake_case** (keyspace / script style), with `:` as
the segment separator — e.g. `device_message:{id}`, `idx:correlation_id:…`,
`idx:external_delivery_id:…`. Hash field names stay on the camelCase side of that divide
(they are the serialized JS object).

Estate Postgres columns (e.g. ADR-011 `command_type`) are unrelated and stay snake_case
on `nxt-backend`.

### 3. Caller selects the plugin via `pluginId`

`device.manufacturer` + `device.protocol` are dropped from the public contract. The caller
passes a required `pluginId`. The service routes enqueue, token generation, and ingress by
that id. `device` on the wire is identity only (`type`, `externalReference`, optional
`relayNode` — generic I/O parent for gateway / DCU / mesh hop; see D6).

Bundled plugin ids (kebab-case, manufacturer + network server where both matter):

| `pluginId` | Role |
|---|---|
| `calin-chirpstack` | CALIN meter framing over ChirpStack (replaces the misnomer `calin-lorawan`) |
| `calin-api-v1` | CALIN HTTP API V1 |
| `calin-api-v2` | CALIN HTTP API V2 |
| `nxt-sts` | STS token generator (token-capable only) |

A message or token request for a plugin that is not enabled fails that request clearly
(ADR-002 decision 6); the process does not crash.

### 4. Service-owned command vocabulary; plugins declare a subset

The service owns a closed `CommandType` set (parity with estate
`meter_interaction_type_enum` — reads / controls / writes / token commands / unsolicited).
Wire validation:

| Surface | Closed by |
|---|---|
| `POST /message/enqueue` `commandType` | `ENQUEUEABLE_COMMAND_TYPES` (excludes unsolicited) |
| `POST /token/generate` `type` | `GENERATE_TOKEN_TYPES` (no `DELIVER_PREEXISTING_TOKEN`) |
| Incoming / unsolicited | Full `COMMAND_TYPES` (incl. `READ_REPORT`, `JOIN_NETWORK`) |

Each plugin declares `supportedCommandTypes` (a subset of enqueueable types). Enqueue checks
enablement, then membership (400 via `UnsupportedCommandTypeError`).
`POST /token/generate` uses a `type`-discriminated Zod union so required payload fields
(`kwh` / `powerLimit`) are enforced on the wire; further adapter-specific checks may still
be plugin-local when needed.

**Amendment (2026-08-03):** replaces the earlier “opaque string; plugins close the set”
wording. The product vocabulary is shared; third-party adapters either use it or we reopen
the wire later. Adding a command is a one-file change in
`src/lib/device-message/command-types.ts`, not a core engine change.

Deliberate drift from the estate enum: this service uses `TOP_UP_KWH` where Postgres
still has `TOP_UP` (kWh credit). Cutover maps at the `nxt-backend` boundary; a future
currency top-up would add a new value rather than overloading the name.

### 5. Inbound auth on the command API: static API key (opt-in)

Command routes (`POST /message/*`, `GET /message/*`, `POST /messages/*`, `POST /token/*`)
authenticate with a static Bearer key when configured:

- **Key set:** require `Authorization: Bearer <key>` validated against
  `DEVICE_MESSAGING_API_KEY`.
- **Key unset/empty:** no inbound auth on those routes (local / quick-start, or an
  operator choice such as private network or reverse-proxy auth). Does not fail boot or
  skip route registration.

`POST /ingress/:pluginId` does **not** use that key. Each plugin may declare
`verifySignature`; opt-out is allowed (ChirpStack HTTP integrations typically have no HMAC).
The inherited Nest `AuthenticationGuard` on `/chirpstack/calin` is not a vendor signature
scheme and is not carried over as the ingress model.

HTTP always forwards the request query string to `plugin.incoming.handle` as
`IncomingHandleMeta.query` (plain string map). Plugins decide whether any query keys are
required.

#### `calin-chirpstack` — required `?event=` (fail closed)

ChirpStack’s HTTP integration appends `?event=<type>`
(`up` / `join` / `ack` / `txack` / `status` / `log` / `location` / `integration`).
This plugin **routes only on that query param**:

| `event` | Handled |
|---|---|
| `txack` / `ack` / `join` / `up` | Yes — mapped to the existing handlers |
| missing, empty, or any other value | No — `handle` returns `null` |

**No fallback to request-body shape** (e.g. inferring join from `devAddr` without `data`).
Ops confirmed ChirpStack sends `event` in production; missing `event` is treated like an
unhandled type. Ingress still returns **HTTP 204** when `handle` returns `null` (engine
no-op) — silence is intentional; do not invent a 4xx that would make ChirpStack retry.

### 6. Outbound event webhook replaces `subscribe()`

Config key: **`eventWebhook`** (renamed from `resultWebhook` — these are delivery
**events**, not terminal-only results). URL in the artifact (`eventWebhook.url`,
ADR-002); signing secret in env (`DEVICE_MESSAGING_WEBHOOK_SECRET`) when HMAC lands.

Module: `src/engine/webhook/`. Seam: `baseService.emitDeliveryEvent` thin-forwards into
`createWebhookService` (peer factory). Engine call sites do not touch Redis webhook keys.

#### Events

Same set as today's `publish()` — with room to add transitions later without breaking
consumers that ignore unknown statuses:

1. First handoff to the network server (`SENT_TO_NS`, only when `retryCount` is 0)
2. Terminal success (`DELIVERY_SUCCESSFUL`)
3. Terminal failure (`DELIVERY_FAILED`, including max-retries and PULL age timeout)
4. Unsolicited uplinks (no `correlationId`)

Mid-pipeline relay-node ACKs (`SENT_TO_DEVICE`) and retry scheduling do not emit events
today and do not in v1.

#### Payload (`WebhookEvent`)

HTTP body **wraps** a trimmed message (legacy `publish()` sent a bare partial
`DeviceMessage` in-process). Type name: `WebhookEvent`. Consumer reads `body.message.*`.

```ts
{
  eventId: string;       // ULID — this notification; reused on HTTP retries
  occurredAt: string;    // ISO-8601
  pluginId: string;
  message: {
    id?: string;         // device-message ULID; may be absent for pure unsolicited
    correlationId?: string; // absent ⇒ unsolicited (adopter business id)
    commandType?: string; // CommandType when present
    deliveryStatus: DeviceMessageDeliveryStatus;
    phase?: 'A' | 'B' | 'C';
    device: {
      type: string;
      externalReference: string;
      relayNode?: { id?: number; externalReference?: string; snr?: number; rssi?: number };
    };
    response?: {
      status: 'EXECUTION_SUCCESS' | 'EXECUTION_FAILURE';
      data?: unknown;
    };
    failureHistory?: FailureReason[];
    unsolicited?: boolean;
  };
}
```

Three ids stay distinct: `message.id` (delivery record), `correlationId` (adopter
interaction), `eventId` (this webhook notification). Wire JSON is **camelCase**. Queue
internals (`deliveryQueueId`, `retryCount`, priority, `requestData`,
`concurrencyRateLimitKey`) are omitted; `GET /message/:correlationId` may expose more.

#### Redis keys (same DB as device queues)

| Key | Type | Role |
|---|---|---|
| `webhook:pending` | sorted set | members = `eventId`, score = `nextAttemptAt` (ms) |
| `webhook:payload:{eventId}` | string (JSON) | `WebhookStoredRecord` (`event` + attempt metadata) |
| `webhook:dlq:{eventId}` | string (JSON) | exhausted payload; TTL = `deadLetterTtlSeconds` |

#### Schedule

Always enqueue to Redis first (durability). Then fire-and-forget the same `drainDue`
function the webhook timer uses (happy path: no intentional timer-tick delay). Timer
remains the safety net for retries and backlog. Device engine never awaits HTTP.

#### Retry / DLQ defaults (`eventWebhook` tuning)

| Knob | Default | Notes |
|---|---|---|
| `maxAttempts` | `6` | First try + 5 retries |
| `baseDelayMs` | `2000` | |
| `backoffMultiplier` | `2` | Gaps: 2+4+8+16+32 ≈ **62s** first→last |
| `maxDelayMs` | `60000` | |
| `deadLetterTtlSeconds` | `604800` | 7 days |

- **2xx** = success. Retry on network errors, **5xx**, **429**, **408**. Do not retry
  other **4xx**.
- Retries reuse the same `eventId`.
- After exhaustion: log (`correlationId` + `eventId`) and retain in DLQ with TTL.
- Device-message success/failure is independent of webhook delivery success.

#### Signing (opt-in) — **deferred**

Normative shape (when the HMAC chunk lands):

- **Secret set:** HMAC-SHA256 over the raw body; headers
  `X-Device-Messaging-Signature: sha256=<hex>` and
  `X-Device-Messaging-Event-Id: <eventId>`.
- **Secret unset:** POST unsigned (local / quick-start). Boot **warns** if a webhook URL is
  configured without a secret; does not fail boot.
- No timestamp/skew window in v1; `eventId` covers idempotent retries. Private network +
  shared secret is the v1 threat model.

**Implementation order (session 32):** durable **unsigned** delivery first; HMAC as a
separate small chunk afterward. Until then, POSTs are unsigned even if
`DEVICE_MESSAGING_WEBHOOK_SECRET` is set (secret unused).

This is **not** the inbound API key: that authenticates callers *to* this service; the
webhook secret authenticates callbacks *from* this service to the consumer.

### 7. OpenAPI is generated from Zod (ADR-001)

The same Zod schemas validate requests/responses and produce the OpenAPI document. The
integration guide (Phase 4) narrates webhook verification and the event set for consumers.

---

## Consequences

### Positive

- One explicit, adoptable contract: action paths, plugin selection, sync tokens, cancel,
  signed-opt-in callbacks.
- Webhook durability is stronger than the stale plan's "single retry then drop," without a
  second queue product.
- Shared vocabulary + plugin subset keeps enqueue validation explicit without a per-plugin
  wire dialect.
- `calin-chirpstack` names the actual network server rather than over-claiming "LoRaWAN."

### Negative / Risks

- Full-pipeline renames touch Redis field names and indexes during the port (accepted;
  behaviour-preserving intent, new key schema in a greenfield Redis).
- Opt-in webhook signing means a misconfigured production deploy can run unsigned if
  operators ignore the boot warning — mitigate in the integration guide and cutover
  checklist.
- Dead-letter replay is ops/manual in v1 (no admin HTTP yet).
- Path style diverges from classic plural REST; documented deliberately.

## Rejected

- **Terminal-only webhooks** — would change `meter-interactions` PROCESSING behaviour;
  rejected in favour of parity with `publish()`.
- ~~**Core `commandType` enum**~~ — **superseded 2026-08-03**: the service now owns
  `CommandType` / `ENQUEUEABLE_COMMAND_TYPES` / `GENERATE_TOKEN_TYPES`; plugins declare
  `supportedCommandTypes`. Fully opaque strings rejected for product parity with the estate
  enum.
- **Manufacturer + protocol on the wire** — split/rejoin dance; replaced by `pluginId`.
- **Separate Redis DB for webhook state** — needless second client; many hosts only expose
  DB 0; key prefixes suffice.
- **Required webhook signing always** — blocks the promised `docker-compose` quick start.
- **Message bus in v1** — deferred; HTTP webhook is enough.
- **Flatter RPC paths** (`/enqueue-message`, …) — rejected in favour of resource/action paths.

## Triggers (revisit when)

- A consumer needs intermediate statuses beyond today's `publish()` set.
- Replay/admin HTTP for dead letters is needed operationally.
- Replay attacks on callbacks justify timestamp + skew.
- A second webhook URL or per-tenant callback routing appears.
- Batch enqueue or batch token generation becomes a real caller need.

## Related

- **ADR-001** — Fastify + Zod; OpenAPI from the same schemas.
- **ADR-002** — `eventWebhook.url` in artifact; secrets in env; plugin enablement.
- **`nxt-backend` ADR-010** — extraction rationale; decision 2 inventory superseded here.
- **`nxt-backend` ADR-005 §11** — integrable extracted service (HTTP in, callbacks out).
- **`nxt-backend` ADR-011** — estate `command_type` vocabulary.
- **`docs/plans/001-extraction.md`** — Phase 3 implements this contract.
