# Local smoke tests (httpYac) for the command API.

File-based requests for the [httpYac](https://marketplace.visualstudio.com/items?itemName=anweber.vscode-httpyac) extension. Lives under `src/http/smoke/` so it sits with the HTTP package without mixing into app modules.

## Setup

1. Install **httpYac** (`anweber.vscode-httpyac`); disable other `.http` extensions if they fight it.
2. Copy `.env.example` → `.env` if needed. For auth’d requests set e.g.
   `DEVICE_MESSAGING_API_KEY=dev-key` (must match `apiKey` in `.httpyac.cjs`).
3. Status bar → httpYac environment **`local`**.
4. `pnpm dev` (config from `DEVICE_MESSAGING_CONFIG_PATH`, stubs in `config.example.json`).
5. Valkey up for enqueue/get persistence (`docker compose up -d valkey` or local Redis).

## Auth

No login/`@ref` dance — command auth is a static Bearer key (ADR-003 §5).

`apiKey` is defined in `.httpyac.cjs` (same pattern as `devApiKey` in `nxt-backend`’s httpYac
config). Prefer that over `$dotenv` in a multi-root workspace, where dotenv often misses this
repo’s `.env`. Keep it equal to `DEVICE_MESSAGING_API_KEY` in `.env`.

```http
Authorization: Bearer {{apiKey}}
```

When the server key is **unset**, command routes skip auth; the header is then ignored.

## How to run

Open `message.http` (or `healthz.http`) and **Send**. Enqueue is `# @name`’d so get can
`# @ref enqueueStubPush` and reuse `correlationId` from the response.

## Files

| File | Role |
|------|------|
| `.httpyac.cjs` | `baseUrl` + `local` env (`.cjs` — package is ESM) |
| `healthz.http` | Liveness (no auth) |
| `message.http` | Enqueue + get (Bearer from `apiKey` in `.httpyac.cjs`) |
