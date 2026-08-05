# ADR-004: Tooling Stack

**Date:** 2026-07-28
**Status:** Accepted

> Closes Decision 7. Unblocks Decision 9 (Docker / CI / OSS hygiene) and Phase 0 scaffold.
> Complements ADR-001: that ADR left the build tool open once NestJS/`emitDecoratorMetadata`
> were dropped; this ADR fills that gap and the rest of the toolchain.

---

## Context

Nothing is scaffolded yet. Phase 0 needs a package manager, Node version, module system, build
tool, test runner, and linter before any domain code lands. Constraints already settled:

- Single Fastify + Zod application; no NestJS, no DI container, no Nx (ADR-001).
- No `emitDecoratorMetadata`, so esbuild-based bundlers are allowed (ADR-001 decision 1).
- The repo is published and self-hosted by strangers — dependency footprint and conceptual weight
  matter more here than inside `nxt-backend`.
- Contributors still cross from the estate, which runs **pnpm** and **Node 24.x** and enforces
  house style via ESLint `teamRules` in `nxt-backend/eslint.config.mjs`.

## Decisions

### 1. pnpm via Corepack; Node 24.x (current LTS line)

- **Package manager:** pnpm, pinned with the `packageManager` field so Corepack resolves it.
  Matches the estate; exact patch is set at scaffold time (estate today: `pnpm@11.12.0`; npm
  latest 11.x may be newer — pin what is current when `package.json` lands).
- **Node:** `engines.node: "24.x"` — always the current LTS major. Native `fetch` is assumed.

### 2. ESM throughout

`"type": "module"`. One module system for app, tests, and config. No CJS dual-publish — this is
an application, not a library.

### 3. tsup for production builds; tsx for local TypeScript execution

- **tsup** (esbuild) produces the deployable output. Fast, small config, no webpack. Lua scripts
  are copied beside the build output (not inlined).
- **tsx** runs and watches TypeScript in development and for ad-hoc scripts without a prebuild.

`tsc` alone was rejected as the primary build: workable, but more glue for ESM + asset copy, and
ADR-001 already cleared the path to esbuild.

### 4. Vitest for tests

Native TypeScript/ESM, no Jest or Nx test harness. Config resolution tests call `loadConfig`
directly; domain tests pass fixtures / `createPluginRegistry` without importing `runtime`.
override pattern and Fastify's usual greenfield choice.

Tests import application code via the package `imports` subpath `#src/*` → `./src/*`
(see `package.json`). That alias works for any file in the package; production `src/`
keeps relative imports.

### 5. ESLint only — house `teamRules`, adapted; no formatter product

Lint and style are enforced by **ESLint 9 flat config** + `typescript-eslint`. There is **no**
Prettier, Biome, or `@stylistic/eslint-plugin`.

Style comes from the estate's `teamRules` block in `nxt-backend/eslint.config.mjs` (quotes,
semi, indent, spacing, brace-style, comma-dangle, unused-vars `_` pattern, pragmatic
`no-explicit-any` off, etc.), ported into this repo and adapted:

| Estate rule surface | Here |
|---|---|
| Style + pragmatic TS overrides | Kept |
| `@nx/eslint-plugin` / module-boundary rules | Dropped — no Nx |
| `no-restricted-imports` for `@nxt/core` / supabase | Dropped — estate-specific; add service-local restrictions later if needed (e.g. plugins must not import Fastify) |

Formatting is therefore ESLint core stylistic rules, as in the house config today — not a second
tool.

## Consequences

### Positive

- Phase 0 and Decision 9 have a concrete base image (`node:24`), install command (`pnpm`), and
  CI steps (`pnpm lint` / `test` / `build`).
- Toolchain matches ADR-001's small-surface goal and stays familiar to estate contributors
  (pnpm, Node 24, same ESLint taste).
- Build is unconstrained by decorator metadata.

### Negative / Risks

- ESLint core stylistic rules are deprecated upstream in favour of `@stylistic`; we accept that
  drift to stay aligned with house `teamRules` without adding another plugin. Revisit if ESLint
  removes them.
- Divergence from Nest/Jest/Nx means `nxt-backend` ADR-006's CI/Docker recipe still must be
  re-derived (Decision 9), not copied.

## Rejected

- **Biome or Prettier** as formatter — maintainer prefers style locked in ESLint only.
- **`@stylistic/eslint-plugin`** — unnecessary while core rule names match house `teamRules`.
- **Jest** — estate habit; wrong weight without Nx/Nest.
- **webpack / `tsc`-only as primary build** — heavier or more glue than tsup for this app.
- **npm / yarn / Bun; Node below current LTS** — no benefit over estate-aligned pnpm + 24.x.

## Triggers (revisit when)

- ESLint removes the core stylistic rules we rely on — then either adopt `@stylistic` or a
  different single lint surface.
- The service grows a publishable plugin SDK package that needs a different build graph.
- Node LTS major advances — bump `engines` and the Docker base together.

## Related

- **ADR-001** — Fastify + Zod; build tool left open; no Nx.
- **ADR-002** — config; boot via `runtime.ts`; tests use `loadConfig` / injected fixtures.
- **ADR-003** — HTTP contract; no tooling collision.
- **`nxt-backend` ADR-006** — estate monorepo toolchain this repo deliberately does not inherit.
- **ADR-005** — Dockerfile, compose, CI/GHCR, metrics, health (closed Decision 9).
