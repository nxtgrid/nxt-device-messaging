# ADR-005: Deployment and OSS Hygiene

**Date:** 2026-07-28
**Status:** Accepted

> Closes Decision 9. Complements ADR-004 (tooling). Release and health-check patterns are
> aligned with sibling OSS service `nxt-sts`, adapted for a Node service that needs Valkey.
> `nxt-backend` ADR-006's Dockerfile/CI recipe does **not** transfer (Nx prune, webpack) —
> re-derived here for a plain Fastify app.
>
> **Amendment (2026-08-12):** Lean process shutdown on `SIGTERM`/`SIGINT` — stop engine +
> webhook timers, `app.close()`, Redis `quit()`. Does not await in-flight ticks (v1).

---

## Context

Phase 0 needs a compose skeleton and CI shape; Phase 4 needs metrics, structured logging, and
contributor hygiene. LICENSE is already **MPL-2.0**. The image name
`ghcr.io/nxtgrid/nxt-device-messaging` was settled when the package name was locked. ADR-002
promises a `docker-compose up` quick start; ADR-003 deliberately does not cover ops endpoints
(`/healthz`, `/metrics`).

`nxt-sts` already locks a lean release model worth mirroring: multi-stage non-root image,
`HEALTHCHECK` against a health URL, CI on PR/`main`, and GHCR publish on semver tags — plus
README guidance that PaaS deploys from a GitHub repo ignore the image `HEALTHCHECK` and must
configure the platform probe themselves.

## Decisions

### 1. Multi-stage Dockerfile on `node:24-slim`; non-root; HEALTHCHECK → `/healthz`

- **Build:** Corepack/pnpm → `pnpm install --frozen-lockfile` → `pnpm build` (tsup per ADR-004).
- **Runtime:** copy `dist`, production dependencies, and Lua scripts; run as `USER node`.
- **HEALTHCHECK:** probe `GET /healthz` on the configured listen port (default **3100**).
- Operators can disable the image check with `docker run --no-healthcheck` when the environment
  performs its own probes.

### 2. `docker-compose.yml`: app + Valkey 8; `.env.example` for secrets

Compose runs the service and **Valkey 8 alpine** (Redis-compatible; preferred for the OSS story).
Config follows ADR-002 (`DEVICE_MESSAGING_CONFIG_*` / bind-mount); secrets and Redis connection
via env, documented in `.env.example`. A `.dockerignore` keeps the build context small.

Unlike `nxt-sts` (stateless, no infra), compose is required here — Redis/Valkey is the only
infrastructure dependency.

### 3. Default listen port 3100

Avoids local collisions with `nxt-backend` api (**3000**) and `nxt-sts` (**8080**) when all
three run simultaneously. Overridable by env at runtime.

### 4. Two GitHub Actions workflows (nxt-sts pattern); no broader CD

| Workflow | Trigger | Job |
|---|---|---|
| `build.yml` | PR + push to default branch | Corepack → `pnpm install --frozen-lockfile` → lint → test → build |
| `release.yml` | push tags `v*.*.*` | Docker build-push to GHCR: `ghcr.io/<org>/<repo>:<tag>` and `:latest` (`GITHUB_TOKEN`, `packages: write`) |

No deployment pipeline beyond image publish. Operators pull the image or build from the
Dockerfile. Exact org/repo path follows `github.repository` (expected
`ghcr.io/nxtgrid/nxt-device-messaging` when hosted there).

### 5. Ops HTTP: `/healthz` and `/metrics` (outside ADR-003)

- **`GET /healthz`** — unauthenticated liveness (process up; Redis ping may be added later
  without changing the path). Used by Dockerfile `HEALTHCHECK` and by PaaS probes.
- **`GET /metrics`** — Prometheus text via `prom-client`, unauthenticated scrape target.
  Minimum series: queue depth by queue, messages by terminal status, retry-count histogram
  (detail from the stale `nxt-backend` plan task 4.3 remains sound).

These are **not** part of the signed command API (ADR-003). Auth stays on command routes only.

### 6. Health checks: image vs PaaS-from-GitHub

Document in the README (same dual-path note as `nxt-sts`):

- **Container image:** Docker `HEALTHCHECK` probes `/healthz` periodically.
- **PaaS / “deploy from GitHub repo”** (e.g. DigitalOcean App Platform): the platform’s own
  health mechanism is used; the image `HEALTHCHECK` is **not**. Configure the platform to probe
  `/healthz` (or TCP on port **3100**).

### 7. Structured logging via Fastify pino

JSON logs in production; named child loggers. Replaces scattered `console.*` (stale plan 4.2’s
Nest `Logger` does not apply). Implementation lands in Phase 4; the choice is locked here.

### 8. Contributor hygiene

- `CONTRIBUTING.md` — PR/branch norms, local `pnpm` lint/test/build, pointer to plugin
  authoring, MPL-2.0 contribution terms (structure inspired by `nxt-sts`, content adapted).
- `.github/ISSUE_TEMPLATE/` stubs.
- README quick-start and config reference expand in Phase 4; positioning already exists.

## Scope vs phases

| Lands in | What |
|---|---|
| **Phase 0** | Dockerfile, compose skeleton, `.env.example`, `.dockerignore`, CI workflow stubs |
| **Phase 4** | `/healthz` + `/metrics` implementation, pino sweep, CONTRIBUTING/issue templates polish, README deploy/health dual-path section, optional local Prometheus scrape note |

## Consequences

### Positive

- Adopters get the same release muscle memory as `nxt-sts` (tag → GHCR) with the extra compose
  story this service needs.
- Local multi-service work (backend + device-messaging + STS) has non-colliding ports.
- Ops endpoints stay out of the consumer contract; scrape and probe stay simple.

### Negative / Risks

- Unauthenticated `/metrics` exposes operational counters — acceptable for typical private
  scrape networks; reverse-proxy auth can be added later if exposed publicly.
- `:latest` on every semver tag can surprise operators who pin only `latest`; document
  preferring version tags in the README.

## Rejected

- **Copying `nxt-backend` ADR-006 Docker/CI** — Nx prune / webpack do not apply.
- **No GHCR until first production cutover** — `nxt-sts` already proves tag→GHCR is the right
  OSS baseline; deferring only delays adopters.
- **Compose without Valkey / Redis-only branding** — Valkey is the default image; Redis remains
  compatible.
- **Nest `Logger` / raw console as the long-term logging story.**

## Triggers (revisit when)

- Redis-aware readiness (distinct from liveness) is needed — may add `/readyz` without removing
  `/healthz`.
- Multi-arch images or signed attestations become a release requirement.
- Public scrape of `/metrics` needs auth.

## Related

- **ADR-004** — pnpm, Node 24, tsup, Vitest, ESLint (what CI and the image build run).
- **ADR-002** — compose quick start; `REDIS_*` / config artifact.
- **ADR-003** — consumer HTTP contract; ops routes deliberately separate.
- **ADR-007** — v1 **single-replica / single-writer** (correlator + timers); multi-replica deferred.
- **`nxt-sts`** — release workflows, HEALTHCHECK, PaaS health-check README note.
- **`nxt-backend` ADR-006** — estate toolchain this repo does not inherit.
