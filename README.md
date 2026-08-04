# nxt-device-messaging

**Reliable, prioritized, retrying command delivery to addressable field devices.**

Give it a command for a device; it takes responsibility for getting it there. The service
queues the command, dispatches it through whichever network server that device speaks to,
tracks it through each delivery stage, retries with exponential backoff when a stage fails,
and reports the final outcome back to you over a signed webhook.

Hardware integrations are plugins. Today the box ships stub PUSH and PULL plugins for local
end-to-end work; real ChirpStack and CALIN V1/V2 adapters are planned next. Both delivery
patterns are supported: *push* (network server callbacks) and *pull* (status polling).
Adding another plugin is a single file.

Redis (or Valkey) is the only infrastructure dependency. There is no relational database.

## What this is not

Not a notification, SMS, or chat system. A "message" here is a command or read request
addressed to a physical device — read a meter's voltage, deliver a credit token, set a
power limit.

## Status

**Walking skeleton in place (Intermezzo closed):** config-driven stub plugins, camelCase
`POST /message/enqueue` + `GET /message/:correlationId` + cancel against local Valkey.
Next engine work (distribute/send, …) continues end-to-end. Webhook polish / real
CALIN·ChirpStack plugins are not wired yet.

Plan and decisions: [`docs/plans/001-extraction.md`](docs/plans/001-extraction.md),
[`docs/decisions-log.md`](docs/decisions-log.md), [`docs/architecture/`](docs/architecture/).

## Prerequisites

- **Node.js 24.x**
- **pnpm 11** (via [Corepack](https://nodejs.org/api/corepack.html): `corepack enable`)
- **Docker** (for Valkey locally, or full compose)

## Quick start (local)

Valkey must be reachable for enqueue/get. Fastest setup: compose **only** the Valkey
service, then run the app on the host.

```bash
corepack enable
pnpm install
cp .env.example .env   # REDIS_HOST=127.0.0.1, stubs via DEVICE_MESSAGING_CONFIG_PATH
docker compose up -d valkey
pnpm dev
```

The process listens on **`PORT`** (default **3100**). `.env` loads via `--env-file` on
`pnpm dev` / `pnpm start`.

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

curl -sS http://127.0.0.1:3100/message/demo-1 \
  -H "Authorization: Bearer dev-key"
```

Config loads from the ADR-002 precedence chain
(`DEVICE_MESSAGING_CONFIG_JSON` → `_URL` → `_PATH` → bundled `config.default.json`).
`.env.example` points `DEVICE_MESSAGING_CONFIG_PATH` at `config.example.json` (stub plugins
`stub-push` / `stub-pull`). Keep `DEVICE_MESSAGING_API_KEY` in sync with
`apiKey` in [`src/http/smoke/.httpyac.cjs`](src/http/smoke/.httpyac.cjs) if you use httpYac
([`src/http/smoke/`](src/http/smoke/)).

Stop Valkey when done: `docker compose stop valkey` (or `down` to remove the container).

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

Opt-in Redis smoke (needs Valkey up):

```bash
RUN_REDIS_SMOKE=1 pnpm exec vitest run test/integration/redis.smoke.spec.ts
```

## Docker

### Valkey only (for `pnpm dev`)

```bash
docker compose up -d valkey
```

Publishes `${REDIS_PUBLISH_PORT:-6379}` → container `6379`. Match `REDIS_HOST` /
`REDIS_PORT` in `.env` (defaults in `.env.example` are `127.0.0.1` / `6379`).

### Compose (app + Valkey)

```bash
cp .env.example .env
docker compose up --build
```

Compose sets `REDIS_HOST=valkey` for the app service so it talks to the Valkey container
on the compose network.

### Image only

```bash
docker build -t nxt-device-messaging .
docker run --rm -p 3100:3100 \
  -e REDIS_HOST=host.docker.internal \
  nxt-device-messaging
```

Point `REDIS_HOST` at a reachable Valkey (compose Valkey, or another host). The image
`HEALTHCHECK` probes `GET /healthz` on `PORT` (default 3100). On PaaS hosts that deploy
from GitHub and ignore image healthchecks, configure the platform probe to the same path
(or TCP on 3100).

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
