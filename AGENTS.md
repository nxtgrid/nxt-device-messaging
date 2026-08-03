# AGENTS.md — nxt-device-messaging

You are a senior TypeScript programmer with a preference for clean programming, explicit
seams, and small dependency footprints.

## What this repo is

A standalone, self-hostable service for reliable, prioritized, retrying delivery of commands
to addressable field devices. It accepts a command over HTTP, queues it, dispatches it through
whichever network server the target device speaks to, tracks it through each delivery stage,
retries with exponential backoff, and reports the outcome back over a signed webhook.

Hardware integrations are **plugins**. Two delivery patterns are supported:

- **PUSH** — the network server accepts the command and calls back with results (LoRaWAN via
  ChirpStack). The bottleneck is the radio network.
- **PULL** — the service creates a task on a vendor HTTP API and polls it for status (CALIN
  API V1/V2). The bottleneck is the vendor API itself.

Redis (or Valkey) is the only infrastructure dependency. There is no relational database.

## Origin and baseline

This service is being **extracted** from the `device-messages` module of
[`nxt-backend`](https://github.com/nxtgrid/nxt-backend). Facts a cold session needs:

| Fact | Value |
|---|---|
| Source path | `legacy/apps/tiamat/src/modules/device-messages/` in `nxt-backend` |
| Baseline commit | **`db5c2ac`** — the copy source is pinned here |
| Source status | **Frozen.** `legacy/` is at parity with the code NXT Grid runs in production, and neither will be updated again |
| Lua scripts | `legacy/apps/tiamat/src/queries/lua/device-messages/` (4 files — they travel with the service) |
| Governing decision | `nxt-backend` **ADR-010** (why the extraction happens) |

Because the source is frozen, no drift-checking is needed. But **read the source, not a plan's
description of it** — documents written before `db5c2ac` describe an older shape, and at least
two known task descriptions are stale because of it (see `nxt-backend` ADR-010's amendment).

## Current status

**Phase 0 complete. Phase 1 foundation through Unit 5 (5.1–5.6). Phase 1b Intermezzo
closed (I0–I3; I4 skipped). Unit 5.6: token + thin `POST /token/generate` +
`runMessageResolutionCycle` + `startEngineTimers` landed. Next: Unit 6 (plugin SPI
polish + config wiring / D5).**

Working rule after Intermezzo (session 16): each Unit 5 slice that has an ADR-003
command/ingress surface ships **thin HTTP + smoke in the same chunk**. Timer-only
paths (distribute / send / poll / resolution) stay internal — exercise via stub
plugins + enqueue/get (no public debug trigger for now).

Already in place: tooling (ADR-004), config loader (ADR-002), `src/runtime.ts` boot exports
(`config`, `pluginRegistry`), Fastify `/healthz` + camelCase command routes on **3100**,
deploy stubs (ADR-005), `src/lib/device-message/` (`schemas.ts` Zod-only + `types.ts`;
camelCase domain/hash fields; snake_case Redis key paths), Redis/Lua, queue primitives,
lifecycle, `src/plugins/` (SPI + `initialQueueKey` / `buildInitialQueueKey` /
`buildConcurrencyRateLimitKey`, catalog, registry, `stub/`), `src/http/` (lean
enqueue/get/cancel; thin `POST /ingress/:pluginId`; thin `POST /token/generate`;
`message-params.ts`; `smoke/` httpYac), `src/engine/` peer factories —
`createBaseService` / `createOutgoingService` / `createIncomingService` /
`createTokenService` + `startEngineTimers` (`engine.enabled`). Errors from
`engine/errors.ts`. Composition root in `main.ts`. **Unit 5 complete.**

- **Dev:** `pnpm install` → `cp .env.example .env` → `docker compose up -d valkey` →
  `pnpm dev` (loads `.env`; port **3100**)
- **Check:** `pnpm lint` / `typecheck` / `test` / `build`
- **Compose:** same `.env`, then `docker compose up --build` (app + Valkey)
- **Smoke:** `src/http/smoke/message.http` (httpYac); opt-in
  `RUN_REDIS_SMOKE=1 pnpm exec vitest run test/integration/`

## Workflow

- Always create a plan before acting, and list actions in to-dos if more than one.
- Address the to-dos one by one, stopping between points to await review and acceptance.
- Never jump to the next point of the to-dos until prompted to do so.
- **The maintainer creates git commits.** Do not commit, amend, or undo commits unless the
  maintainer explicitly asks you to do so for that specific action.
- **No unsanctioned exploration.** When a command fails, do not launch open-ended debugging
  (long shell chains, repeated Docker runs, simulated environments, scratch scripts, or
  "let me investigate" loops). Stay on repo files and short, task-specific commands. Propose a
  minimal fix or ask the maintainer; only investigate deeper if they explicitly ask.
- **Design decisions belong to the maintainer.** When one surfaces, put it to them with a
  recommended answer and wait for confirmation before acting. Resolve dependencies between
  decisions one at a time.
- **Look facts up; never ask what the environment can answer.** Filesystem, git history, and
  the source module are all readable.

## Communication

- **Ask questions inline in the chat.** Write them as normal prose, one question at a time.
  Asking several at once is bewildering.
- **Never use structured question-picker / multiple-choice UI** (e.g. Cursor's AskQuestion
  tool). Plain text lets the maintainer add nuance, extra context, or instructions.
- Keep answers concise and direct.

## Decision records

ADRs live in `docs/architecture/` as numbered files. This repo owns **how the service is
built**; `nxt-backend` owns **why it was extracted** and what changes on its side.

**Citation convention:** a bare `ADR-00N` means *this repo's* ADR. Always write
`nxt-backend ADR-00N` when citing the other repo, because the numbers collide — most
confusingly, both repos have an ADR-001 and both are relevant here.

### This repo's ADRs

| # | Decision |
|---|---|
| 001 | Fastify + Zod runtime; no DI container; plugins are plain objects |
| 002 | Configuration mechanism — JSON artifact + env secrets, per-plugin schemas |
| 003 | Public HTTP contract — command API, ingress, outbound webhook |
| 004 | Tooling — pnpm, Node 24, ESM, tsup, tsx, Vitest, ESLint (house teamRules) |
| 005 | Deployment & OSS hygiene — Docker, Valkey compose, CI/GHCR, metrics, health |
| 006 | Initial queue keys (`buildInitialQueueKey`) + named admission (`spacing` / `concurrency` / `custom`) |

### `nxt-backend` ADRs that constrain this repo

Read these **only** when the task touches their domain. Read Context and Status first and stop
if the ADR does not apply. Cap at 2–3 before proposing an approach.

| `nxt-backend` ADR | Read it when |
|---|---|
| **010** — device-messaging extraction | Any structural question about scope, endpoints, or the plugin contract. Start here |
| **001** — PUSH/PULL pattern divergence | Touching timeouts, rate limiting, concurrency, or per-plugin tuning; this repo’s **ADR-006** is the actionable admission SPI |
| **007** — configuration & wiring | Touching config. This repo's ADR-002 adapts it rather than replacing it |
| **005** — inter-host communication | How consumers integrate; §11 classifies this service as an integrable extracted service |

When you make a new architectural decision, add a numbered ADR here **and** add a row to the
index table above.

### Where to look for state

| File | What it holds |
|---|---|
| `docs/decisions-log.md` | **Read first.** What is settled, what is open, and carried findings. Append every session |
| `docs/plans/001-extraction.md` | The executable plan: five phases, ten port units, and the import ledger |

`nxt-backend`'s `docs/plans/001-device-messaging-service-extraction.md` is **stale and marked
non-executable**. It remains useful only as a source of task detail (retry semantics, queue stages,
the plugin interface sketch) — never as instructions.

## Code conventions

- English for all code and documentation. Declare types for parameters and return values;
  avoid `any`. JSDoc on public functions and types.
- **PascalCase** for types and classes, **camelCase** for values and functions,
  **kebab-case** for files and directories, **UPPERCASE** for environment variables,
  **SCREAMING_SNAKE_CASE** for constants. Avoid magic numbers.
- Verb prefixes for booleans: `isLoading`, `hasError`, `canRetry`.
- Prefer short single-purpose functions, early returns over nesting, and a functional style.
- Prefer immutability: `readonly` for data that does not change, `as const` for literals.
- **Factory + closure DI (preferred when practical).** Inject deps into a factory function;
  keep private helpers in that scope; return a plain object literal as the interface. Example:
  `createOutgoingService({ registry, delivery, baseService })`. Complements ADR-001 §2
  (no DI container). Pure
  helpers and module-level Redis stay fine outside this shape.
- **Keep framework types out of the plugin layer.** Plugins are plain objects, not classes with
  decorators. A plugin author should not need to know which HTTP framework the service uses.
