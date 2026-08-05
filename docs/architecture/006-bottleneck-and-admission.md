# ADR-006: Initial Queue Keys and Admission Strategies

**Date:** 2026-07-29
**Status:** Accepted — **Amendment (2026-07-31, session 18b):** D1 revised —
embed `pluginId` in the initial-queue key via `buildInitialQueueKey`; SPI method
renamed `bottleneckKey` → `initialQueueKey`. Boot-time `bottleneckKind` registry
(session 18) **reverted**. See §1, § D1, and decisions-log session 18b.

> How plugins declare *where* work is queued (initial Redis key) and *whether* the
> distributor may take the next message from that queue (admission). Replaces the frozen
> module’s `redisKeys.queueInitial` branches and `distributeToNetworkServers` string-split on
> `lorawan_network` / `gateway`. Complements `deliveryPattern: 'PUSH' | 'PULL'` (Unit 6) —
> delivery pattern is *how confirmation works after send*; admission is *how hard we hit the
> constrained node before/while sending*.

**Read this when:** touching `initialQueueKey`, `buildInitialQueueKey`, distribute/admission,
initial queue keys, `messageFullCleanup` queue lists, plugin SPI (Unit 6), or LoRaWAN/DCU
rate limiting.
**Related:** this repo ADR-001 (plain-object plugins), ADR-002 (plugin tuning via config),
`nxt-backend` ADR-001 (PUSH/PULL divergence; adapter-declared constraints),
`nxt-backend` ADR-010 (plugin queue-key sketch; historically named `bottleneckKey`).

---

## Context

In the frozen source (`db5c2ac`):

1. **`queueInitial`** in `keys.ts` hardcodes manufacturer/protocol → Redis sorted-set name
   (`queue:lorawan_network:{grid|unassigned}` vs `queue:gateway:{id}`).
2. **`distributeToNetworkServers`** parses those keys (`split(':')`) and branches policy:
   LoRaWAN → time lock (flood spacing); gateway → concurrency cap + claim slot.
3. That conflates **human topology labels**, **admission policy**, and **PUSH/PULL delivery**
   into core string matching — fine for a company built-in, hostile to an OSS plugin surface.

Real constraints (why two admission policies exist):

| Admission node | Example plugin | Constraint | Queue bucket | Admission today |
|---|---|---|---|---|
| Radio network (any GW) | `calin-chirpstack` | Don’t flood the network | Per `networkId` (or `unassigned`) | Spacing / flood lock (~2s) |
| Meter pinned to one DCU | `calin-api-v1` / `v2` | Don’t overload the DCU / vendor API | Per DCU (`gateway.id` in legacy) | Concurrency cap (e.g. 5) + rate-limit key |

Hard cutover (no dual-write Redis) lets us change key ownership and distributor shape without
migrating live queues.

---

## Decisions (locked)

### 1. Plugins own `initialQueueKey({ networkId, device }) → string`

Each plugin returns the full Redis **initial-queue** key from topology inputs only
(`networkId` + `device`, incl. DCU/gateway) — not the full create DTO. Core **does not**
port `queueInitial` and **does not** branch on manufacturer/protocol to build that key.

Plugins **should** build keys with the shared helper (arguments document the segments):

```ts
buildInitialQueueKey(pluginId, kind, id) → `queue:{pluginId}:{kind}:{id}`
```

| Segment | Role |
|---|---|
| `pluginId` | Owning plugin — **only** segment distribute parses for `registry.get` |
| `kind` | Human label for the admission node (`network`, `gateway`, `dcu`, …) — not policy |
| `id` | Instance of that node (`42`, `unassigned`, …) — partitions the bucket |

Examples:

| Plugin | Situation | Key |
|---|---|---|
| `calin-chirpstack` | Network `42` | `queue:calin-chirpstack:network:42` |
| `calin-chirpstack` | `networkId: null` | `queue:calin-chirpstack:network:unassigned` |
| `calin-api-v1` | DCU / gateway `7` | `queue:calin-api-v1:gateway:7` (or `…:dcu:7`) |

Core must **not** switch on `kind` for admission or PUSH/PULL. `kind` vocabulary
(`gateway` vs `dcu`) is plugin-local (see D4).

The SPI name is **`initialQueueKey`** (agnostic): it is the Redis sorted set we enqueue into
before distribute. The physical “bottleneck / admission node” story lives in the key
segments and in `admission`, not in the method name.

### 2. Admission is declared with named strategies (+ custom escape hatch)

Plugins do **not** reimplement `canDistribute` / `onClaim` for the two known topologies.
They select a **named strategy**; core executes shared primitives. Knobs are plugin tuning
defaults, overridable via ADR-002 config.

```ts
type Admission =
  | { strategy: 'spacing'; minIntervalMs: number }
  | { strategy: 'concurrency'; maxInFlight: number }
  | {
      strategy: 'custom';
      canDistribute: (ctx: DistributeCtx) => Promise<boolean>;
      onClaim?: (ctx: DistributeCtx & { messageId: string }) => Promise<void>;
      onRelease?: (ctx: DistributeCtx & { messageId: string }) => Promise<void>;
    };
```

| Strategy | Maps to today’s behaviour | When to use |
|---|---|---|
| `spacing` | `lockQueueForTimeMs` on the initial queue before pick | Network flood control (LoRaWAN-like) |
| `concurrency` | SCARD/SADD via `buildConcurrencyRateLimitKey(queueKey)`; validate+clean when at cap; claim stores key on message; release via `messageFullCleanup` / `fromAnyToRetry` | DCU / API concurrency (CALIN API-like) |
| `custom` | Plugin-supplied hooks | Third case that doesn’t fit the two primitives |

**Distributor rule:** resolve **plugin** for an active queue → run that plugin’s admission →
then shared `pickNextAndMoveToNs`. **No** `if (kind === 'network')` in core.

**Concurrency rate-limit key (session 19):** the admission node is already the initial-queue
partition. Core derives
`queue:{pluginId}:{kind}:{id}` → `rate_limit:{pluginId}:{kind}:{id}` via
`buildConcurrencyRateLimitKey` — plugins do **not** supply a key builder. A different grain
than the queue partition is `custom` admission.

### 3. `deliveryPattern` stays separate

`deliveryPattern: 'PUSH' | 'PULL'` (Unit 6) answers post-send confirmation (webhook stages vs
poll `queue_awaiting_task:{pluginId}`). It is **not** inferred from the initial-queue key and
is **not** a substitute for admission.

### 4. Core stays agnostic of which plugins exist

No core constants listing plugin ids, PULL ids, or admission-node kind vocabularies. Enabled
plugins come from config (ADR-002); each declares `initialQueueKey`, `admission`, and
`deliveryPattern`.

---

## Deferred (must revisit with criteria below)

Do **not** invent a half solution in Unit 2. Record interim seams; decide when the wiring unit
runs.

### D1 — How distribute maps `queueKey` → `pluginId`

**Decided (2026-07-31, revised session 18b): embed `pluginId` in the key.**

| Option | Idea | Outcome |
|---|---|---|
| A. Enqueue-time Redis owner map | `HSET queue_owner {queueKey} {pluginId}` | Rejected for now (extra write + GC) |
| B. Boot-time kind registry | Plugin declares `bottleneckKind`; unique kinds among enabled plugins | **Reverted** (session 18) — extra SPI + uniqueness for little gain |
| **C. `pluginId` in key (chosen)** | `buildInitialQueueKey` → `queue:{pluginId}:{kind}:{id}`; parse segment 2 | No kind index; V1/V2 naturally get separate buckets |

**Locked behaviour:**

1. Plugins implement `initialQueueKey` using `buildInitialQueueKey(plugin.id, kind, id)`.
2. Distribute: `getPluginIdFromInitialQueueKey(queueKey)` → `registry.get(pluginId)`.
   Parse is lookup-only — **never** chooses admission or PUSH/PULL.
3. Human `kind` is for operators reading Redis; admission id/partition is the full key
   (and thus the `id` among peers of that plugin).
4. Legacy shapes (`queue:lorawan_network:…`, `queue:gateway:…`) are not preserved — hard
   cutover. CALIN V1 and V2 no longer share one `queue:gateway:{id}` ZSET; each plugin has
   its own `queue:{pluginId}:…` buckets (acceptable).

**Interim:** helper + SPI landed; distribute wiring is D3 / Unit 5.3.

### D2 — `messageFullCleanup` and the set of in-flight queue keys

**Agreed direction:** Redis repo does not hardcode `PUSH_QUEUE_KEYS` /
`PULL_PATTERN_IMPLEMENTATIONS`. Cleanup ZREMs a fixed stage-key list (+ awaiting-task),
plus correlation/external indexes. Concurrency admission release reads
`concurrencyRateLimitKey` from the message hash (written at claim) — not a caller-threaded
option.

**Design criteria when exploring (Unit 5 with Unit 6 registry):**

1. One array of `inFlightQueueKeys` is the **default hypothesis** — try it first.
2. If release of concurrency track keys, initial-queue membership, or pattern-specific stages
   prove a flat array insufficient, widen the cleanup context object with evidence — don’t
   guess in Unit 2.
3. Shared stage key `queue_in_flight_to_ns` (`QUEUE_NS_KEY`) remains real and lands with Unit 3;
   it is **not** rejected — only importing Unit 3 from Unit 2 / hardcoding PULL plugin lists is.
4. Concurrency `onRelease` must run on the same paths that today `SREM` the gateway rate-limit
   set (success cleanup, retry, final fail).

**Interim (Unit 2 → refined):** At concurrency **claim**, Redis stores
`concurrencyRateLimitKey` on the message hash (`claimConcurrencyRateLimit` = SADD + HSET).
`messageFullCleanup` / `fromAnyToRetry` SREM that field (legacy-shaped) — no key threading.
The field is **stripped** before adopter-facing emit / command GET (`omitInternalFields`).
`messageFullCleanup` takes **no options** — fixed ZREM of stage keys +
`queue_awaiting_task:{pluginId}` (not dynamic initial/retry queues; cancel ZREMs those first).
Full exit-path audit is still D2 work.

### D3 — Wire `distribute` + admission execution

**Decided / landed (2026-08-01, session 19; sendOne 2026-08-02 session 20;
concurrency claim/store refined later):**
`OutgoingService.distributeToNetworkServers` on
`createOutgoingService({ registry, delivery, baseService })`
runs named strategies (`spacing` / `concurrency` / `custom`); resolve plugin via D1-C.
Concurrency rate-limit keys are derived by core (`buildConcurrencyRateLimitKey`) — no
SPI `rateLimitKey`. On concurrency claim: SADD the track set and HSET
`concurrencyRateLimitKey` on the message (`claimConcurrencyRateLimit`). After pick:
fire-and-forget `sendOne` + PUSH|PULL post-send moves. Send-fail / success / timeout
cleanup does **not** pass a key — `messageFullCleanup` and `fromAnyToRetry` read and
SREM the stored field. Enqueue fire-and-forget kick (opt-out `kickDistributeOnEnqueue`
for tests). Cron / `engine.enabled` still Unit 5.6.

### D4 — Cosmetics

Whether CALIN API keys use `gateway` vs `dcu` as the human `kind` segment is **plugin-local**.
No uniqueness constraint across plugins (unlike the reverted D1-B kind registry).

Wire parent field is **`device.relayNode`** (D6, 2026-08-04) — generic I/O parent. That does
**not** force the Redis `kind` segment to be `relayNode`; plugins still choose `dcu` /
`gateway` / etc. for admission keys.

---

## Consequences for the port plan

| Unit | Implication |
|---|---|
| **2** Redis + Lua | Port generic key builders; **omit `queueInitial`**. Rename indexes/fields per ADR-003. `queueAwaitingTask(pluginId)`. Parameterize cleanup queue list (D2 interim). `REDIS_*`, Ramda, local Lua. **Do not** implement owner hash or admission engine yet. |
| **3–4** | Queue stage keys (`QUEUE_NS_KEY`, PUSH gw/device, PULL awaiting) stay; no topology parse for policy. |
| **5** | `distribute` uses plugin admission (D3); D1-C parse → `registry.get`. |
| **6** | SPI: `initialQueueKey`, `admission`, `deliveryPattern`, plus send/incoming/token as already planned. |
| **7–9** | Each plugin supplies concrete `initialQueueKey` (via helper) + `admission`. |

---

## Rejected

- **Keep parsing `lorawan_network` / `gateway` in core for policy** — encodes company topology
  in the OSS core.
- **Boot-time `bottleneckKind` registry (session 18 D1-B)** — solved lookup with extra SPI and
  global kind uniqueness; superseded by embedding `pluginId` in the key.
- **Every plugin must hand-write `canDistribute` / `onClaim`** — duplicates the two known
  primitives; named strategies are the default, `custom` is the escape hatch.
- **SPI `rateLimitKey` / `trackKey` on concurrency admission** — the initial-queue key already
  identifies the admission node; `buildConcurrencyRateLimitKey` derives the Redis key.
- **Infer admission or PUSH/PULL from the human `kind` segment** — same smell as legacy.
- **Core `BUNDLED_PLUGIN_IDS` / `PULL_PATTERN_IMPLEMENTATIONS`** — already rejected in Unit 1;
  reinforced here.

---

## Example declarations (non-normative sketch)

```ts
import { buildInitialQueueKey } from './_shared/initial-queue-key.js';

// calin-chirpstack
{
  id: 'calin-chirpstack',
  deliveryPattern: 'PUSH',
  initialQueueKey: (m) =>
    buildInitialQueueKey(
      'calin-chirpstack',
      'network',
      m.networkId == null ? 'unassigned' : String(m.networkId),
    ),
  admission: { strategy: 'spacing', minIntervalMs: 2_000 },
}

// calin-api-v1 — concurrency rate-limit key is derived from the initial queue key
{
  id: 'calin-api-v1',
  deliveryPattern: 'PULL',
  initialQueueKey: (m) =>
    buildInitialQueueKey('calin-api-v1', 'dcu', String(m.device.relayNode!.id)),
  admission: { strategy: 'concurrency', maxInFlight: 5 },
}
```
