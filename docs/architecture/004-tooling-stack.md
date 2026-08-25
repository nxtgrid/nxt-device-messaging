# ADR-004: Tooling Stack

**Date:** 2026-07-28
**Status:** Accepted — amended 2026-08-25 (`@nxt/device-messaging-contract` wire package;
not a plugin SDK)

> Closes Decision 7. Unblocks Decision 9 (Docker / CI / OSS hygiene) and Phase 0 scaffold.
> Complements ADR-001: that ADR left the build tool open once NestJS/`emitDecoratorMetadata`
> were dropped; this ADR fills that gap and the rest of the toolchain.

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

`"type": "module"`. One module system for app, tests, config, and the contract package.
No CJS dual-publish.

The **service** is an application. `@nxt/device-messaging-contract` (decision 6) is a small
ESM library in the same repo; it does not change that.

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

### 6. Adopter wire package `@nxt/device-messaging-contract` (amendment 2026-08-25)

TypeScript/Zod adopters get a **route-level** allowlist of HTTP and outbound-webhook schemas
plus inferred types — not an in-process engine, not the plugin SPI.

- **Name / path:** `@nxt/device-messaging-contract` in `packages/contract/`. Allowlist lives
  in that package’s barrel (`src/index.ts`). Ingress (`pluginIdParamsSchema`) is vendor→service
  and is not exported.
- **Zod is a peer.** Schemas are runtime (`.parse()`). Types are `z.infer`. No custom `.d.ts`
  emitter; no inverted “TypeScript first, then Zod” source of truth (ADR-001 / ADR-003 still
  own the wire in Zod).
- **Build:** the same **tsup** as the app (`pnpm build:contract`), `zod` external, ESM only,
  no sourcemap in `dist`. The server image and the app CI `pnpm build` path do not emit this
  package; emit is for npm publish (`prepack` / a release workflow). Still `"private": true`
  until that publish slice.
- **Not a plugin SDK.** Hardware plugins stay first-party in this repository (ADR-001). A
  third-party plugin SDK remains a trigger, not this package.

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
- The service grows a **plugin SDK** package (SPI for third-party hardware). That is not
  `@nxt/device-messaging-contract`.
- Node LTS major advances — bump `engines` and the Docker base together.

## Related

- **ADR-001** — Fastify + Zod; build tool left open; no Nx.
- **ADR-002** — config; boot via `runtime.ts`; tests use `loadConfig` / injected fixtures.
- **ADR-003** — HTTP/webhook contract; the npm package is that contract’s TS/Zod artifact.
- **`nxt-backend` ADR-006** — estate monorepo toolchain this repo deliberately does not inherit.
- **ADR-005** — Dockerfile, compose, CI/GHCR, metrics, health (closed Decision 9).
