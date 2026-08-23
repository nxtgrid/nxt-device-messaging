# Decisions log — nxt-device-messaging

Parked and open work that is not yet an ADR. Architectural decisions live in
`docs/architecture/`.

Do **not** append a session diary here. New architecture → ADR. Plan work → that plan’s
session notes. A parked item that lands → strike the row and cite the ADR or plan note.

Extraction-era journal: [`docs/archive/decisions-log-extraction.md`](archive/decisions-log-extraction.md)
(load only when a row below cites it).

---

## State of the service

Standalone command-delivery service: enqueue / get / cancel, PUSH ingress, token mint,
outbound webhook, metrics, first-party plugins (CALIN V1/V2, ChirpStack, nxt-sts, stubs).
Message lifecycle is a stage table (ADR-008). One replica (ADR-007). Core-owned
`PluginTuning` defaults (ADR-002).

Plan 002 is finished: [`docs/plans/002-architecture-review.md`](plans/002-architecture-review.md).
Leftovers live in **Parked / revisit** below.

---

## Open decisions

Nothing blocking. Follow-ups are **Parked / revisit**.

---

## Parked / revisit (canonical)

Work that is **intentionally not next**. Do not keep a second list in `AGENTS.md`. When an
item lands, strike it here.

### This repo

| Item | Revisit when | Detail |
| --- | --- | --- |
| **Shutdown v2** — await in-flight engine ticks + webhook `drainChain`; optionally gate `storeAndEmit` after shutdown starts. v1 only stops timers then closes Fastify/Redis. Seam exists: `outgoingService.drainInFlightSends(budgetMs)`. Wiring: stop timers → drain (~15–20 s of a 30 s grace) → close Redis/Fastify | Before cutover, or when reopening shutdown | ADR-005; ADR-008 §8 |
| **Webhook drain concurrency** — drain is serialized in-process | Serialized drain lags under event volume | ADR-003 |
| **ChirpStack ingress enqueue-then-ack** — vendor HTTP posts once and does not retry; v1 awaits `handle` before 204 for local Redis durability only | Designing durable raw-event enqueue → 204 → async process | — |
| **Thorough cleanup suite** — every exit path (success, final failure, PULL age cap, cancel) must leave zero Redis references, PUSH and PULL. Sweep list is derived from the stage table (ADR-008 §7); remaining work is the dedicated integration suite | Dedicated integration suite | ADR-006 **D2**; ADR-008 §7 |
| **Plugin HTTP hygiene** — redact `decoderKey` (and CALIN bodies) in error logs; map vendor token errors to useful HTTP statuses; trailing-slash base URLs. Fetch safety deadline already landed (`CLIENT_SAFETY_DEADLINE_MS`) | A sanitization / client-hardening pass | — |

### Product / ops trigger

| Item | Revisit when | Detail |
| --- | --- | --- |
| Message-bus adapter for delivery events | A consumer needs broker delivery | ADR-003 |
| Dead-letter admin / replay HTTP | Ops needs DLQ replay without Redis access | ADR-003 |
| Debug HTTP to run distribute / poll once | Manual smoke against timers becomes painful | — |
| HA / multi-replica (leader election, Redis-backed correlator) | Operator needs >1 replica | ADR-007; plan 002 item 11 |
| Capability bundles — token providers vs delivery plugins | A second token-only plugin, or a delivery plugin that also mints | Plan 002 item 12; designed, not built |
| Domain rename (`DeviceMessage` → dispatch-flavoured) | Only if the service is real and test-covered | ADR-001 Rejected |

---

## Deferred with locked criteria

Not free-for-all open questions. Revisit only at the named trigger.

| # | Topic | Revisit at | ADR |
| --- | --- | --- | --- |
| D2 | Whether cleanup still needs more than the stage-table key list + concurrency key | Thorough cleanup suite (parked above) | 006 |
