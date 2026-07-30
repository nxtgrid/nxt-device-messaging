# nxt-device-messaging

**Reliable, prioritized, retrying command delivery to addressable field devices.**

Give it a command for a device; it takes responsibility for getting it there. The service
queues the command, dispatches it through whichever network server that device speaks to,
tracks it through each delivery stage, retries with exponential backoff when a stage fails,
and reports the final outcome back to you over a signed webhook.

Hardware integrations are plugins. Three ship in the box — LoRaWAN via ChirpStack, and the
CALIN V1 and V2 vendor HTTP APIs — covering both delivery patterns: *push*, where the
network server calls back, and *pull*, where the service polls for status. Adding a fourth
is a single file.

Redis (or Valkey) is the only infrastructure dependency. There is no relational database.

## What this is not

Not a notification, SMS, or chat system. A "message" here is a command or read request
addressed to a physical device — read a meter's voltage, deliver a credit token, set a
power limit.

## Status

**Phase 0 complete** (tooling, config loader, Fastify shell, Docker/CI stubs). Domain logic
is still being ported from the frozen `device-messages` module in
[nxt-backend](https://github.com/nxtgrid/nxt-backend) (see its ADR-010). The HTTP command
API, plugins, and Redis engine are not runnable yet — local boot today serves
`GET /healthz` only.

Plan and decisions: [`docs/plans/001-extraction.md`](docs/plans/001-extraction.md),
[`docs/decisions-log.md`](docs/decisions-log.md), [`docs/architecture/`](docs/architecture/).

## Prerequisites

- **Node.js 24.x**
- **pnpm 11** (via [Corepack](https://nodejs.org/api/corepack.html): `corepack enable`)
- **Docker** (optional — for compose / image builds)

## Quick start (local)

```bash
corepack enable
pnpm install
cp .env.example .env   # loads via --env-file on `pnpm dev` / `pnpm start`
pnpm dev
```

The process listens on **`PORT`** (default **3100**). Check liveness:

```bash
curl -sS http://127.0.0.1:3100/healthz
# {"ok":true}
```

Config loads from the ADR-002 precedence chain
(`DEVICE_MESSAGING_CONFIG_JSON` → `_URL` → `_PATH` → bundled `config.default.json`).
`.env.example` points `DEVICE_MESSAGING_CONFIG_PATH` at `config.example.json` (stubs enabled).

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | `tsx watch` with `.env` loaded if present |
| `pnpm build` | Production bundle to `dist/` via tsup |
| `pnpm start` | Run `dist/main.js` with `.env` loaded if present |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Vitest (unit tests under `test/`) |
| `pnpm test:watch` | Vitest watch mode |

Pre-commit runs lint-staged on staged `.ts` files, then `pnpm typecheck`.

## Docker

### Compose (app + Valkey)

```bash
cp .env.example .env
docker compose up --build
```

Compose sets `REDIS_HOST=valkey` for the app service. Valkey is included so the stack
matches the intended runtime; the service does not connect to Redis until Phase 1.

### Image only

```bash
docker build -t nxt-device-messaging .
docker run --rm -p 3100:3100 nxt-device-messaging
```

The image `HEALTHCHECK` probes `GET /healthz` on `PORT` (default 3100). On PaaS hosts that
deploy from GitHub and ignore image healthchecks, configure the platform probe to the same
path (or TCP on 3100).

## Configuration (summary)

| Surface | Examples |
|---|---|
| JSON artifact | `engine`, `delivery`, `resultWebhook`, `plugins` — see `config.example.json` |
| Env (secrets / connection) | `REDIS_*`, `DEVICE_MESSAGING_API_KEY`, `DEVICE_MESSAGING_WEBHOOK_SECRET` |
| Env (ops) | `PORT` (default `3100`) |
| Env (config source) | `DEVICE_MESSAGING_CONFIG_JSON` / `_URL` / `_PATH` |

Full rules: [ADR-002](docs/architecture/002-configuration-mechanism.md).

## License

[MPL-2.0](./LICENSE)
