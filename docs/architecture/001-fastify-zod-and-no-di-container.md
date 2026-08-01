# ADR-001: Fastify + Zod Runtime; No DI Container

**Date:** 2026-07-27
**Status:** Accepted

> Supersedes `nxt-backend` ADR-010 decision 1 on the framework choice only ("Extract to a
> standalone **NestJS** application"). The decision *to extract*, and everything else in
> ADR-010, stands. Recorded as an amendment in `nxt-backend` ADR-010.

---

## Context

The `device-messages` module is being extracted from `nxt-backend`'s `legacy/apps/tiamat`
(baseline `db5c2ac`) into this repo. `nxt-backend` ADR-010 decision 1 specified a standalone
**NestJS** application, on the reasonable assumption that the module was a NestJS module and
would stay one. Measuring the module's actual framework surface changes that picture.

### The module's real NestJS footprint

~5,150 lines of TypeScript across 34 files, plus two Lua scripts. Of that:

| NestJS feature | Actual usage |
|---|---|
| `@Injectable()` | 8 classes |
| `@Global()` / `@Module()` | 1 file |
| Constructor DI | 4 constructors — 3 inject the vendor adapter services, 1 injects `HttpService` |
| `@Cron()` | 2 timers (2s resolution cycle, 5s pull poll) |
| Controllers, guards, pipes, interceptors | **none** — the HTTP entry point lives in `tiamat`, not the module |

Everything else is framework-free. The Redis client is a module-level singleton, not a provider.
Adapters read `process.env` at import time. The queue state machine, retry logic, Lua scripts,
and PUSH/PULL lifecycle have no framework dependency at all.

### The plan already removes the framework from the plugin layer

`nxt-backend`'s execution plan (task 3.7) removes `@Injectable()` from every adapter and empties
the module's `providers` array; the 4 DI constructors are precisely what the plugin registry
(task 3.2) deletes; task 3.7 prefers replacing `@nestjs/axios` with native `fetch` "to reduce
NestJS coupling in the plugin layer."

So the real choice was never "NestJS or Fastify" in the abstract. It was:

- **(a)** a NestJS shell around framework-free plugins — after which NestJS wraps ~5 route
  handlers, 2 timers, config loading, and logging; or
- **(b)** a Fastify shell around the same framework-free plugins.

The delta between them is the shell alone. All domain logic is identical either way and moves
verbatim.

### Constraints that bear on the choice

- **Plugin authoring is a product goal.** ADR-010's stated goal is that adding a hardware
  integration requires authoring a single plugin, with no core file changes. Plugin authors are
  expected to include third parties.
- **This repo is published and self-hosted by strangers.** Dependency footprint, startup cost,
  and conceptual weight are product qualities here in a way they are not inside `nxt-backend`.
- **No production risk to preserve.** The company runs the private repo; `legacy/` is frozen and
  never boots. `nxt-backend` ADR-008's "move working, then modify" principle applies here for
  *reviewability*, not uptime.
- **Zod is already the house contract language** for configuration (`nxt-backend` ADR-007
  decision 2), and this service's config follows it (ADR-002).

## Decisions

### 1. Fastify is the HTTP runtime; NestJS is not used

The service is a plain Node application built on **Fastify**. NestJS is not a dependency.

What the shell must provide is small: five or so routes, request validation, an API-key guard,
an OpenAPI document, two periodic timers, structured logging, and graceful shutdown. Fastify
covers this directly.

Consequences worth naming explicitly:

- No `reflect-metadata`, `rxjs`, `class-validator`, `class-transformer`, or `@nestjs/*`.
- No `emitDecoratorMetadata` requirement, so the constraint that forced webpack in `nxt-backend`
  ADR-006 decision 3 (and made it reject esbuild for Nest apps) **does not apply here**. The
  actual build-tool choice is deliberately left open and decided separately with the rest of the
  tooling.
- A single-application repo, so Nx is not adopted.

### 2. No DI container; a composition root wires plain objects

There is no dependency-injection container. `main.ts` acts as the composition root: it loads and
validates config, constructs the Redis client, registers the enabled plugins, wires the core
services, and starts the HTTP server.

The 4 existing DI constructors are removed rather than replaced — three of them exist only to
inject the vendor adapters that the plugin registry supersedes, and the fourth injects
`HttpService`, which decision 4 removes.

**Preferred composition shape (locked 2026-07-31):** when a module needs dependencies, prefer a
**factory function** that takes them as arguments, defines private helpers in that factory’s
scope (closures over the deps), and returns a **plain object literal** as the public interface.
Reference: `createOutgoing({ registry, delivery })` in `src/engine/outgoing.ts`. This is
explicit DI without a container — testable, no classes, no framework. Use it when practical;
thin pure helpers and module-level Redis/Lua remain fine outside this shape.

### 3. Zod is the single source of truth for validation and OpenAPI

Request and response schemas are Zod schemas, surfaced to Fastify through a Zod type provider so
that the **same** schema validates requests and generates the OpenAPI document. `class-validator`
plus `@nestjs/swagger` (as the plan's tasks 2.2 and 2.5 assumed) would have needed two parallel
declarations of every shape.

This also means configuration and the HTTP contract are described in one language, which matters
because plugins contribute to both (ADR-002 decision 3).

### 4. Plain timers replace `@nestjs/schedule`; native `fetch` replaces Axios

- The two `@Cron()` jobs become plain interval timers in the composition root.
- `@nestjs/axios` / `HttpService` in the token adapter is replaced by native `fetch`. Vendor
  adapters that use `axios` directly may keep it until their plugin migration; the framework
  binding is what matters, not the HTTP client.

**Behaviour note:** `@Cron()` does not guard against overlapping runs, so a resolution cycle that
outlives its 2-second interval currently re-enters. A plain `setInterval` reproduces that
faithfully. Adding an in-flight guard would be an improvement, not a port — if it is added it
must be recorded as a deliberate deviation, not slipped in.

### 5. Plugins are plain objects, and the plugin layer stays framework-free

A plugin is a plain object satisfying the `DeviceMessagingPlugin` type. It is not a class, carries
no decorators, and imports no framework types. This is the load-bearing consequence of decisions
1–2: a plugin author needs to know TypeScript, their hardware, and the plugin contract — nothing
about Fastify, and nothing about how the service is wired.

## Consequences

### Positive

- The plugin contract is documentable and authorable without teaching a framework, which is what
  ADR-010's single-file-plugin goal actually requires.
- The framework-stripping work that the plan schedules for phase 3 happens **once**, during the
  move, instead of building a NestJS shell and dismantling it later.
- Materially smaller dependency and build surface for a service that third parties deploy:
  no decorator metadata, no webpack requirement, no Nx, faster cold start.
- One schema language (Zod) for config, request validation, and OpenAPI.

### Negative / Risks

- **Divergence from the house stack.** Every other backend in the estate is NestJS. Contributors
  crossing repos meet a different idiom, and `nxt-backend` ADR-006's proven Dockerfile and CI
  recipe do not transfer as-is; they must be re-derived for a plain Node app.
- **The move and the modification are merged** for the shell, against `nxt-backend` ADR-008's
  two-pass principle. Mitigated by scope: the domain logic files move verbatim, and only the
  module wiring, the two cron sites, and the one Axios call change shape. Accepted because there
  is no production instance whose behaviour must be preserved.
- Fewer batteries included. Anything NestJS would have supplied (lifecycle hooks, interceptors)
  is hand-rolled if it turns out to be needed.

## Rejected

- **NestJS shell with plain-object plugins** (the plan as originally written). Rejected because it
  pays the framework's full cost — dependencies, decorator-metadata build constraints, Nx — for a
  shell of five routes and two timers, while the plugin layer, which is the whole point of the
  service, gets no benefit from it.
- **NestJS with the Fastify adapter.** Rejected: it keeps the conceptual weight this decision is
  trying to shed and adds an adapter layer, gaining only raw throughput that is irrelevant for a
  service whose bottleneck is a radio network or a 30-second vendor API.
- **Renaming the domain vocabulary** (`DeviceMessage` → dispatch-flavoured names) alongside the
  framework change. Rejected as gratuitous churn during a behaviour-preserving move, and because
  it would land on the Redis key schema and the two Lua scripts — the least-tested, most
  subtly-behaved part of the system. Revisit as a follow-up once the service is real and covered.

## Triggers (revisit when)

- The service needs a genuinely DI-shaped concern (request-scoped lifetimes, deep object graphs
  with many shared collaborators) — reconsider a lightweight container, not NestJS.
- Hand-rolled shell code (lifecycle, error mapping, observability wiring) grows to the point where
  a framework would demonstrably be less code.
- A plugin author reports the contract is hard to implement — the signal that decision 5 failed.

## Related

- **ADR-002** — configuration mechanism; Zod contract and per-plugin schema composition.
- **`nxt-backend` ADR-010** — the extraction decision; decision 1 amended by this ADR.
- **`nxt-backend` ADR-001** — PUSH/PULL divergence; its recommended per-adapter configuration is
  what the plugin contract must carry.
- **`nxt-backend` ADR-006** — the monorepo/NestJS toolchain this repo deliberately does not inherit.
- **`nxt-backend` ADR-008** — the two-pass move-then-modify principle, and why the shell is an
  accepted exception.
