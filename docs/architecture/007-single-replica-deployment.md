# ADR-007: Single-replica / single-writer deployment (v1)

**Date:** 2026-08-08
**Status:** Accepted

> Locks **v1 deploy topology**: one running app process. Complements ADR-005 (how we
> package and run). Aligns with `nxt-backend` ADR-010 §6. Does **not** design
> multi-replica HA — only records the constraint, what depends on it, and when to reopen.

**Read this when:** scaling replicas, touching the LoRaWAN up/ack correlator, engine
timers / reapers, or any review that proposes Redis-backed correlation “for HA.”
**Related:** ADR-005 (deployment), ADR-003 (ingress). HA / multi-replica is parked in
`docs/decisions-log.md`.

---

## Context

Several pieces of this service assume a **single writer** (one Node process owning
in-memory state and timer ticks):

1. **`calin-chirpstack` up/ack correlator** — process-local `Map` keyed by
   `deduplicationId`, 10s TTL, interval GC (`lib/correlate-request-response.ts`).
   ChirpStack may deliver ACK and data uplink as separate HTTP POSTs; if those hit
   different app replicas, the halves never meet and the combined delivery result is
   dropped after TTL.
2. **Engine timers** (`startEngineTimers`: distribute / send / poll / resolution) —
   no leader election; N replicas ⇒ N competing ticks.

`nxt-backend` ADR-010 §6 already deferred HA (leader election + Redis-backed correlator)
until extraction is done and there is evidence of multi-instance demand. This repo’s
extraction plan lists the same item under Deferred. A Unit 10 review restated the
correlator risk and suggested implementing Redis correlation now.

We still want **one process in v1**, but the constraint must be visible **in this
repo** (operators and cold sessions should not have to open `nxt-backend` ADR-010).

Terminology used here:

| Term | Meaning |
|---|---|
| **Single-replica** | Ops deploy shape: one running app instance (`replicas: 1`) |
| **Single-writer** | Why: one process owns correlator memory and timer loops |
| **Multi-replica** | Horizontal scale / active-active ingress (future; not designed here) |

---

## Decisions

### 1. v1 is single-replica / single-writer

Ship and operate **one** app replica. Do not run multiple processes against the same
Valkey for ingress or timers until this ADR is revisited.

### 2. Process-local LoRaWAN correlator stays

Keep the in-memory correlator (legacy parity). Do not move it to Redis/Valkey, inject
it through the plugin factory, or make `incoming.handle` async **as part of HA**, until
a trigger below fires.

### 3. Multi-replica work is deferred — not designed here

When reopened, likely workstreams include (illustrative, **undecided**):

- Shared correlator in Valkey (atomic partial merge + TTL; remove process-local GC)
- Async `handle` (or equivalent) so Redis I/O can be awaited from ingress
- Leader election or equivalent so only one replica runs distribute/send/poll/resolution
  timers

Choosing among those (and sticky ingress as a stopgap) is **out of scope** for this ADR.

### 4. Document the constraint at the call site

The correlator module and the parked HA row in `docs/decisions-log.md` point here so the
single-writer assumption is not tribal knowledge.

---

## Consequences

### Positive

- Matches production intent and `nxt-backend` ADR-010 §6 without a premature HA design.
- Review pressure to “fix” multi-replica correlator has a clear accept/defer home.
- Operators get an explicit `replicas: 1` rule in-repo.

### Negative / Risks

- Availability is limited to one process (restart = brief downtime; no active-active
  ingress).
- Accidentally scaling replicas > 1 can silently drop LoRaWAN ACK/UP pairs and double
  timer work — mitigated by this ADR + ops discipline, not by code fences.

## Rejected (for now)

- **Implement Redis correlator in Unit 10 / Phase 3 polish** — heavy lift; no multi-replica
  demand yet; contradicts ADR-010 §6 interim.
- **A full “how we do HA” ADR that picks Redis/Lua/leader shapes now** — decide when the
  trigger fires, with evidence.

## Triggers (revisit when)

- An operator needs **>1 replica** for throughput or availability (same trigger language
  as `nxt-backend` ADR-010).
- Sticky load-balancing of ChirpStack ingress is proposed as a permanent substitute for
  a shared correlator (re-evaluate; usually insufficient alone if timers still multi-fire).
- Evidence of ACK/UP split drops in an environment that already violated single-replica.

## Related

- **ADR-005** — Docker, compose, CI/GHCR, health/metrics (packaging; not replica count).
- **ADR-003** — `POST /ingress/:pluginId` (each request handled independently).
- **`nxt-backend` ADR-010 §6** — single-writer v1; HA deferred at extraction time.
- **`src/plugins/calin-chirpstack/lib/correlate-request-response.ts`** — process-local Map.
- **`docs/decisions-log.md`** — HA / multi-replica parked.
