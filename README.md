# nxt-device-messaging

**Reliable, prioritized, retrying command delivery to addressable field devices.**

Give it a command for a device; it takes responsibility for getting it there. The service
queues the command, dispatches it through whichever network server that device speaks to,
tracks it through each delivery stage, retries with exponential backoff when a stage fails,
and reports the outcome over a signed webhook.

Hardware integrations are **plugins** (CALIN HTTP V1/V2, CALIN over ChirpStack, nxt-sts
tokens, plus stubs for local work). Two delivery patterns: *push* (the network server
calls back) and *pull* (we poll a vendor API).

Redis (or Valkey) is the only infrastructure dependency. There is no relational database.

**Run one replica.** Timers and the correlator are in-process (see
[ADR-007](docs/architecture/007-single-replica-deployment.md)).

## What this is not

Not a notification, SMS, or chat system. A "message" here is a command or read addressed
to a physical device — read a meter's voltage, deliver a credit token, set a power limit.

## Status

The command API, ingress, outbound webhook, metrics, and first-party plugins are in place.
Still an extraction: treat it as early, pin image tags, read
[integrating](docs/guides/integrating.md) before wiring a consumer.

Plan and decisions: [`docs/plans/001-extraction.md`](docs/plans/001-extraction.md),
[`docs/decisions-log.md`](docs/decisions-log.md), [`docs/architecture/`](docs/architecture/).

## Prerequisites

- **Node.js 24.x**
- **pnpm 11** (via [Corepack](https://nodejs.org/api/corepack.html): `corepack enable`)
- **Docker** (for Valkey locally, or full compose)

## Quick start (local)

Valkey must be reachable. Fastest: compose **only** Valkey, run the app on the host.

```bash
corepack enable
pnpm install
cp .env.example .env   # REDIS_HOST=127.0.0.1, stubs via DEVICE_MESSAGING_CONFIG_PATH
docker compose up -d valkey
pnpm dev
```

Listens on **`PORT`** (default **3100**). `.env` loads via `--env-file` on `pnpm dev` /
`pnpm start`.

```bash
curl -sS http://127.0.0.1:3100/healthz
# {"ok":true}

curl -sS -X POST http://127.0.0.1:3100/message/enqueue \
  -H "Authorization: Bearer dev-key" \
  -H "Content-Type: application/json" \
  -d '{
    "commandType": "READ_CREDIT",
    "priority": 1,
    "pluginId": "stub-push",
    "networkId": 42,
    "correlationId": "demo-1",
    "device": { "type": "ELECTRICITY_METER", "externalReference": "m-1" }
  }'
```

Browse the contract at [`http://127.0.0.1:3100/swagger`](http://127.0.0.1:3100/swagger).
How to consume enqueue + webhooks: [integrating](docs/guides/integrating.md).

Config loads `DEVICE_MESSAGING_CONFIG_JSON` → `_URL` → `_PATH` → bundled
`config.default.json`. `.env.example` points `_PATH` at `config.example.json` (stub
plugins). Keep `DEVICE_MESSAGING_API_KEY` in sync with `apiKey` in
[`src/http/smoke/.httpyac.cjs`](src/http/smoke/.httpyac.cjs) if you use httpYac
([`src/http/smoke/`](src/http/smoke/)).

Stop Valkey when done: `docker compose stop valkey`.

## Observability

| Path | Auth | Role |
|---|---|---|
| `GET /healthz` | none | Liveness (`{"ok":true}`). Process is up; not a Redis readiness check. |
| `GET /metrics` | none | Prometheus text. Queue depths, terminals, retries, webhook results. |

Logs are **pretty** on stdout by default. Set `"logging": { "stdout": "json" }` in the
config artifact when an aggregator tails the process.

### Health checks: image vs PaaS

- **Container image:** Docker `HEALTHCHECK` probes `GET /healthz` on `PORT` (default 3100).
  Disable with `docker run --no-healthcheck` if the platform probes instead.
- **PaaS / "deploy from GitHub"** (e.g. DigitalOcean App Platform): the image
  `HEALTHCHECK` is ignored. Point the **platform** health check at `/healthz` (or TCP
  on 3100).

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | `tsx watch` with `.env` loaded if present |
| `pnpm build` | Production bundle to `dist/` via tsup |
| `pnpm start` | Run `dist/main.js` with `.env` loaded if present |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Vitest (unit) |
| `pnpm test:integration` | Redis smoke (needs Valkey; sets `RUN_REDIS_SMOKE=1`) |
| `pnpm test:watch` | Vitest watch |

Pre-commit: lint-staged on staged `.ts`, then `pnpm typecheck`.

## Docker

### Valkey only (for `pnpm dev`)

```bash
docker compose up -d valkey
```

Publishes `${REDIS_PUBLISH_PORT:-6379}` → container `6379`. Match `REDIS_HOST` /
`REDIS_PORT` in `.env` (defaults `127.0.0.1` / `6379`).

### Compose (app + Valkey)

```bash
cp .env.example .env
docker compose up --build
```

Compose sets `REDIS_HOST=valkey` so the app talks to Valkey on the compose network.

### Image only

```bash
docker build -t nxt-device-messaging .
docker run --rm -p 3100:3100 \
  -e REDIS_HOST=host.docker.internal \
  nxt-device-messaging
```

`REDIS_HOST` must reach Valkey. Prefer a version tag from GHCR over `:latest`:

`ghcr.io/nxtgrid/nxt-device-messaging:vX.Y.Z`

Tagged releases publish a multi-arch image (`linux/amd64` and `linux/arm64`) to
GHCR as that tag and `:latest`. Apple Silicon and x86 hosts pick the matching
arch.

## Configuration (summary)

| Surface | Examples |
|---|---|
| JSON artifact | `engine`, `logging`, `delivery`, `eventWebhook`, `plugins` — `config.example.json` |
| Env (secrets / connection) | `REDIS_*`, `DEVICE_MESSAGING_API_KEY`, `DEVICE_MESSAGING_WEBHOOK_SECRET` |
| Env (ops) | `PORT` (default `3100`) |
| Env (config source) | `DEVICE_MESSAGING_CONFIG_JSON` / `_URL` / `_PATH` |

Plugin secrets (`CALIN_API_V1_*`, `CHIRPSTACK_*`, …) are only required when that plugin
is in `plugins[]`. Full rules: [ADR-002](docs/architecture/002-configuration-mechanism.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MPL-2.0](./LICENSE)
