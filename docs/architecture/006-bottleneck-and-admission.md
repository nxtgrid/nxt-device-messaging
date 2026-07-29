# ADR-006: Queue Bottleneck Keys and Admission Strategies

**Date:** 2026-07-29
**Status:** Accepted

> How plugins declare *where* work is queued (topology → Redis key) and *whether* the
> distributor may take the next message from that queue (admission). Replaces the frozen
> module’s `redisKeys.queueInitial` branches and `distributeToNetworkServers` string-split on
> `lorawan_network` / `gateway`. Complements `deliveryPattern: 'PUSH' | 'PULL'` (Unit 6) —
> delivery pattern is *how confirmation works after send*; admission is *how hard we hit the
> bottleneck before/while sending*.

**Read this when:** touching `bottleneckKey`, distribute/admission, initial queue keys,
`messageFullCleanup` queue lists, plugin SPI (Unit 6), or LoRaWAN/DCU rate limiting.
**Related:** this repo ADR-001 (plain-object plugins), ADR-002 (plugin tuning via config),
`nxt-backend` ADR-001 (PUSH/PULL divergence; adapter-declared constraints),
`nxt-backend` ADR-010 (plugin `bottleneckKey` sketch).

---

## Context

In the frozen source (`db5c2ac`):

1. **`queueInitial`** in `keys.ts` hardcodes manufacturer/protocol → Redis sorted-set name
   (`queue:lorawan_network:{grid|unassigned}` vs `queue:gateway:{id}`).
2. **`distributeToNetworkServers`** parses those keys (`split(':')`) and branches policy:
   LoRaWAN → time lock (flood spacing); gateway → concurrency cap + claim slot.
3. That conflates **topology naming**, **admission policy**, and **PUSH/PULL delivery** into
   core string matching — fine for a company built-in, hostile to an OSS plugin surface.

Real topologies (why two policies exist):

| Topology | Example plugin | Constraint | Queue bucket | Admission today |
|---|---|---|---|---|
| Radio network (any GW) | `calin-chirpstack` | Don’t flood the network | Per `network_id` (or `unassigned`) | Spacing / flood lock (~2s) |
| Meter pinned to one DCU | `calin-api-v1` / `v2` | Don’t overload the DCU / vendor API | Per DCU (`gateway.id` in legacy) | Concurrency cap (e.g. 5) + track set |

Hard cutover (no dual-write Redis) lets us change key ownership and distributor shape without
migrating live queues.

---

## Decisions (locked)

### 1. Plugins own `bottleneckKey(message) → string`

Each plugin returns the full Redis initial-queue key for a message. Core **does not** port
`queueInitial` and **does not** branch on manufacturer/protocol/`pluginId` to build that key.

**Naming convention** (documentation only — not a core parse protocol):

```text
queue:{bottleneckKind}:{bottleneckId}
```

Examples:

| Plugin | Situation | Key |
|---|---|---|
| `calin-chirpstack` | Network `42` | `queue:lorawan_network:42` |
| `calin-chirpstack` | `network_id: null` | `queue:lorawan_network:unassigned` |
| `calin-api-v1` | DCU / gateway `7` | `queue:gateway:7` (or `queue:dcu:7` — **plugin vocabulary**) |

`{bottleneckKind}` and id encoding are **plugin-owned**. Core must not switch on
`lorawan_network` vs `gateway`. Renaming `gateway` → `dcu` is a plugin concern only.

`enqueueDeviceMessage(dto, queueKey)` already takes the key from the caller; the caller becomes
`plugin.bottleneckKey(dto)` once the registry exists (Unit 5/6).

### 2. Admission is declared with named strategies (+ custom escape hatch)

Plugins do **not** reimplement `canDistribute` / `onClaim` for the two known topologies.
They select a **named strategy**; core executes shared primitives. Knobs are plugin tuning
defaults, overridable via ADR-002 config.

```ts
type Admission =
  | { strategy: 'spacing'; minIntervalMs: number }
  | {
      strategy: 'concurrency';
      maxInFlight: number;
      /** Redis set of in-flight message ids; default may derive from queueKey inside the plugin. */
      trackKey?: (queueKey: string) => string;
    }
  | {
      strategy: 'custom';
      canDistribute: (ctx: DistributeCtx) => Promise<boolean>;
      onClaim?: (ctx: DistributeCtx & { messageId: string }) => Promise<void>;
      onRelease?: (ctx: DistributeCtx & { messageId: string }) => Promise<void>;
    };
```

| Strategy | Maps to today’s behaviour | When to use |
|---|---|---|
| `spacing` | `lockQueueForTimeMs` on the bottleneck queue before pick | Network flood control (LoRaWAN-like) |
| `concurrency` | SCARD/SADD rate-limit set; validate+clean when at cap; claim after pick; release on cleanup/retry/fail | DCU / API concurrency (CALIN API-like) |
| `custom` | Plugin-supplied hooks | Third topology that doesn’t fit the two primitives |

**Distributor rule:** resolve **plugin** for an active queue → run that plugin’s admission →
then shared `pickNextAndMoveToNs`. **No** `if (queueType === 'lorawan_network')` in core.

Any key parsing needed for `trackKey` lives in the **plugin** (or a helper the plugin opts
into), not in the distributor’s topology switch.

### 3. `deliveryPattern` stays separate

`deliveryPattern: 'PUSH' | 'PULL'` (Unit 6) answers post-send confirmation (webhook stages vs
poll `queue_awaiting_task:{pluginId}`). It is **not** inferred from bottleneck kind and is
**not** a substitute for admission.

### 4. Core stays agnostic of which plugins exist

No core constants listing plugin ids, PULL ids, or bottleneck kinds. Enabled plugins come from
config (ADR-002); each declares `bottleneckKey`, `admission`, and `deliveryPattern`.

---

## Deferred (must revisit with criteria below)

Do **not** invent a half solution in Unit 2. Record interim seams; decide when the wiring unit
runs.

### D1 — How distribute maps `queueKey` → `pluginId`

**Open.** Two candidates (pick at Unit 5/6, not earlier unless blocked):

| Option | Idea | Pros | Cons |
|---|---|---|---|
| **A. Enqueue-time Redis map** | `HSET queue_owner {queueKey} {pluginId}` (or richer set member) | Exact ownership; kinds need not be globally unique | Extra Redis write; must GC owner entries; schema change |
| **B. Boot-time kind registry** | Plugin registers `bottleneckKind`; distribute splits once for **lookup only** | No per-enqueue owner write | Kinds must be unique across enabled plugins; disabled plugin leaves ambiguous queues |

**Design criteria when choosing:**

1. Core still must not branch on topology for *policy* — lookup may parse kind **only** to
   find the plugin, never to choose spacing vs concurrency.
2. Prefer correctness when two plugins could theoretically share a kind string → bias **A**.
3. Prefer minimal Redis surface if kinds are guaranteed unique by convention → **B** may win.
4. Hard cutover: either option is allowed; no dual-write migration story required.
5. Document the choice in the decisions log the session it lands; update this ADR’s Status
   note or add an amendment bullet.

**Interim (until D1 lands):** none required for Unit 2 (no distributor yet).

### D2 — `messageFullCleanup` and the set of in-flight queue keys

**Agreed direction:** Redis repo does not hardcode `PUSH_QUEUE_KEYS` /
`PULL_PATTERN_IMPLEMENTATIONS`. Cleanup accepts (or later resolves) the list of queue keys to
`ZREM`, plus correlation/external indexes and optional concurrency track key from the message.

**Design criteria when exploring (Unit 5 with Unit 6 registry):**

1. One array of `inFlightQueueKeys` is the **default hypothesis** — try it first.
2. If release of concurrency track keys, initial-queue membership, or pattern-specific stages
   prove a flat array insufficient, widen the cleanup context object with evidence — don’t
   guess in Unit 2.
3. Shared stage key `queue_in_flight_to_ns` (`QUEUE_NS_KEY`) remains real and lands with Unit 3;
   it is **not** rejected — only importing Unit 3 from Unit 2 / hardcoding PULL plugin lists is.
4. Concurrency `onRelease` must run on the same paths that today `SREM` the gateway rate-limit
   set (success cleanup, retry, final fail).

**Interim (Unit 2):** `messageFullCleanup(message, { inFlightQueueKeys?, concurrencyRateLimitKey? })`.
Defaults cover known stage keys + `queue_awaiting_task:{pluginId}`; concurrency set is **only**
cleared when the caller passes `concurrencyRateLimitKey` (plugin `trackKey` — core does not
invent gateway keys). Callers in Unit 5+ must pass the full scrub set; registry may build it
later. Full exit-path audit (retry queue, initial bottleneck queues, cancel) is still D2 work.

### D3 — Wire `distribute` + admission execution

**When:** Unit 5 (engine) + Unit 6 (plugin interface/registry).

**Criteria:** implement named strategies as core primitives; plugins only declare; config tunes
`minIntervalMs` / `maxInFlight` (ADR-002). Replace string-split policy in
`distributeToNetworkServers` entirely.

### D4 — Cosmetics

Whether CALIN API keys use `gateway` vs `dcu` in `{bottleneckKind}` is **plugin-local**. No
core ADR needed unless two bundled plugins would collide under boot-time kind registry (D1-B).

---

## Consequences for the port plan

| Unit | Implication |
|---|---|
| **2** Redis + Lua | Port generic key builders; **omit `queueInitial`**. Rename indexes/fields per ADR-003. `queueAwaitingTask(pluginId)`. Parameterize cleanup queue list (D2 interim). `REDIS_*`, Ramda, local Lua. **Do not** implement owner hash or admission engine yet. |
| **3–4** | Queue stage keys (`QUEUE_NS_KEY`, PUSH gw/device, PULL awaiting) stay; no topology parse. |
| **5** | `distribute` uses plugin admission (D3); needs D1 mapping choice. |
| **6** | SPI: `bottleneckKey`, `admission`, `deliveryPattern`, plus send/incoming/token as already planned. |
| **7–9** | Each plugin supplies concrete `bottleneckKey` + `admission` (`spacing` vs `concurrency`). |

---

## Rejected

- **Keep parsing `lorawan_network` / `gateway` in core forever** — encodes company topology in
  the OSS core.
- **Every plugin must hand-write `canDistribute` / `onClaim`** — duplicates the two known
  primitives; named strategies are the default, `custom` is the escape hatch.
- **Infer admission or PUSH/PULL from the queue key middle segment** — same smell as today.
- **Core `BUNDLED_PLUGIN_IDS` / `PULL_PATTERN_IMPLEMENTATIONS`** — already rejected in Unit 1;
  reinforced here.

---

## Example declarations (non-normative sketch)

```ts
// calin-chirpstack
{
  id: 'calin-chirpstack',
  deliveryPattern: 'PUSH',
  bottleneckKey: (m) =>
    `queue:lorawan_network:${m.network_id == null ? 'unassigned' : m.network_id}`,
  admission: { strategy: 'spacing', minIntervalMs: 2_000 },
}

// calin-api-v1
{
  id: 'calin-api-v1',
  deliveryPattern: 'PULL',
  bottleneckKey: (m) => `queue:gateway:${m.device.gateway!.id}`,
  admission: {
    strategy: 'concurrency',
    maxInFlight: 5,
    trackKey: (queueKey) => `rate_limit:gateway:${queueKey.split(':')[2]}`,
  },
}
```
