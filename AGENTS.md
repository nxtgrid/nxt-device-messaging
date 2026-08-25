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

Token-only plugins (`deliveryPattern: 'NONE'`, currently `nxt-sts`) mint tokens and have no
delivery path, admission, or initial queue.

Redis (or Valkey) is the only infrastructure dependency. There is no relational database.

**Run one replica** (ADR-007). HTTP on **3100**.

## Layout

| Path | Role |
|---|---|
| `src/engine/lifecycle/` | Stage table, moves, actions, one 1000 ms runner |
| `src/engine/` | Outgoing, incoming, token, provisioning, webhook, timers, composition peers |
| `src/plugins/` | SPI (`PushPlugin \| PullPlugin \| TokenOnlyPlugin`) + first-party plugins |
| `src/http/` | Command / ingress / token / provisioning routes, OpenAPI |
| `src/lib/redis-repository/` | Message, stage, and admission stores |
| `src/config/` | JSON artifact + env |
| `src/metrics/` | Prometheus `/metrics` |
| `packages/contract/` | Adopter wire contract (`@nxt/device-messaging-contract`) |
| `src/main.ts` | Composition root |

## Commands

- **Dev:** `pnpm install` → `cp .env.example .env` → `docker compose up -d valkey` → `pnpm dev`
- **Check:** `pnpm lint` / `typecheck` / `test` / `build`
- **Contract package:** `pnpm build:contract` (emit for npm publish; not the server image)
- **Smoke:** `src/http/smoke/` (httpYac); opt-in `pnpm test:integration` (Valkey; `RUN_REDIS_SMOKE=1`)

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
- **Look facts up; never ask what the environment can answer.** Filesystem and git history
  are readable.

## Communication

- **Ask questions inline in the chat.** Write them as normal prose, one question at a time.
  Asking several at once is bewildering.
- **Never use structured question-picker / multiple-choice UI** (e.g. Cursor's AskQuestion
  tool). Plain text lets the maintainer add nuance, extra context, or instructions.
- Keep answers concise and direct.

## Decision records

ADRs live in `docs/architecture/` as numbered files. A bare `ADR-00N` means this repo.

Read ADRs **only** when the task touches their domain. Read Context and Status first and
stop if the ADR does not apply. Cap at 2–3 before proposing an approach.

| # | Decision |
|---|---|
| 001 | Fastify + Zod runtime; no DI container; plugins are plain objects |
| 002 | Configuration mechanism — JSON artifact + env secrets, per-plugin schemas |
| 003 | Public HTTP contract — command API, ingress, outbound webhook |
| 004 | Tooling — pnpm, Node 24, ESM, tsup, tsx, Vitest, ESLint (house teamRules) |
| 005 | Deployment & OSS hygiene — Docker, Valkey compose, CI/GHCR, metrics, health |
| 006 | Initial queue keys (`buildInitialQueueKey`) + named admission (`spacing` / `concurrency`) |
| 007 | Single-replica / single-writer v1 — correlator + timers; multi-replica deferred |
| 008 | Message lifecycle is a stage table — one runner, one 1000 ms tick, pipelines as data |

When you make a new architectural decision, add a numbered ADR here **and** add a row to the
index table above.

### Where to look

| File | What it holds | Load when |
|---|---|---|
| `docs/decisions-log.md` | Parked / open / deferred-with-criteria | The task is follow-ups or “is this parked?” |
| `docs/plans/002-architecture-review.md` | Finished follow-up plan | Only if the task cites it |
| `docs/architecture/` | ADRs | The index above says so |
| `docs/archive/` | Named-era journals | The task cites a file there. Not otherwise. |

Do not append a diary to `docs/decisions-log.md`. New architecture → ADR. Plan work → that
plan’s session notes. Parked item lands → strike the parked row.

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
  (no DI container). Pure helpers and module-level Redis stay fine outside this shape.
- **Keep framework types out of the plugin layer.** Plugins are plain objects, not classes with
  decorators. A plugin author should not need to know which HTTP framework the service uses.

## Plugins (first-party)

Plugins are authored and tested **in this repository**, not as an external third-party
ecosystem. Treat plugin authors as co-maintainers of the SPI.

- Make the plugin ↔ engine contract **clear and documented** (JSDoc, ADR-006, examples).
  The SPI is a discriminated union on `deliveryPattern`: `PushPlugin` | `PullPlugin` |
  `TokenOnlyPlugin`.
- Prefer a sane API over nailing every misuse shut with runtime checks, Zod at call sites,
  or defensive parsing of keys the helper just built.
- Rely on the implementor to pass correct segments and to cover their plugin with in-repo
  tests. Add fail-fast validation only for footguns that are easy to hit during normal
  in-repo development and cheap to catch at the choke point — not for every imaginable
  malformed input.
