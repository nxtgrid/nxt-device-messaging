# DigitalOcean App Platform

Add a **web service** from this GitHub repo, branch **`main`**, autodeploy on push. App Platform uses the root Dockerfile when it sees it — leave that as the build strategy.

HTTP port **3100** (the process listens on `PORT`; set the component port to 3100 so they match). Instance count **1**.

Command routes need a non-empty `DEVICE_MESSAGING_API_KEY` if this component has a public URL. Ingress (`POST /ingress/:pluginId`) is unauthenticated; only expose it if a vendor must reach it.

## Health check

App Platform **does not** run the Dockerfile `HEALTHCHECK`. Configure the component's own probe or a deploy can look healthy on TCP while the process is not serving.

| Setting | Value |
|---|---|
| Kind | HTTP |
| Path | `GET /healthz` |
| Port | **3100** (same as the HTTP port) |
| Expect | `200` and `{"ok":true}` |

Control panel: the component → **Health Check** → HTTP, path `/healthz`.

## Always set

App Platform has no volume mounts. Put the JSON artifact in **`DEVICE_MESSAGING_CONFIG_JSON`** (encrypt it). Enable the plugins you need and set that plugin's secrets from [`.env.example`](../../.env.example).

| Variable | Notes |
|---|---|
| `DEVICE_MESSAGING_API_KEY` | Bearer for enqueue / GET / cancel / token |
| `DEVICE_MESSAGING_CONFIG_JSON` | Full artifact (highest precedence). Start from [`config.example.json`](../../config.example.json) |
| `DEVICE_MESSAGING_WEBHOOK_SECRET` | HMAC for outbound events; same value the adopter verifies |

Bindable names below use the **component `name`** from the app spec (the prefix is at most 32 characters).

## Same app: Valkey or Redis

If a Valkey/Redis resource is already in this app, **bind it to this component**. Use that database's component `name` from the app spec (example below: `valkey`):

| Variable | Value |
|---|---|
| `REDIS_HOST` | `${valkey.HOSTNAME}` |
| `REDIS_PORT` | `${valkey.PORT}` |
| `REDIS_USERNAME` | `${valkey.USERNAME}` if the cluster has one |
| `REDIS_PASSWORD` | `${valkey.PASSWORD}` |
| `REDIS_TLS` | `true` |

DigitalOcean Valkey/Redis **always** needs TLS. Without `REDIS_TLS=true` the client connects, the socket drops, and you get `connected` logs about every 2 seconds (ioredis reconnect cap), then `MaxRetriesPerRequestError` on shutdown `quit()`.

`${valkey.HOSTNAME}` is the **public** cluster DNS. There is no `PRIVATE_HOSTNAME` bindable. The `private-` prefix (and `${valkey.DATABASE_PRIVATE_URL}`) only work if this App Platform app and the database are on the **same VPC** — that is not automatic and is still awkward to arrange. If they are not, use `${valkey.HOSTNAME}` as-is. If they are, you can set `REDIS_HOST=private-${valkey.HOSTNAME}` (or paste the private host in full). `${valkey.DATABASE_PRIVATE_URL}` is a full `rediss://…` string; this process does not parse it.

If **another process in the app already uses that instance** (for example an in-process engine on logical DB `0`), set `REDIS_DB` to a free index so keys do not collide.

Do not put this database's password in **app-wide** env if other components should not see it.

## Same app: nxt-sts

If [nxt-sts](https://github.com/nxtgrid/nxt-sts) is another component in this app (example name `nxt-sts`):

```text
NXT_STS_URL=${nxt-sts.PRIVATE_URL}
```

That is already `http://…:8080`. Do not use `*.ondigitalocean.app` for this hop. Keep STS **off the public internet** (`POST /token` has no API key). Add `{ "id": "nxt-sts" }` to `plugins[]` only if this process should mint STS tokens.

## Same app: the adopter API (webhook)

If the operations API that receives delivery events is in this app, put its **private** URL in the config artifact:

```json
"eventWebhook": { "url": "${api.PRIVATE_URL}/device-messaging/events" }
```

Bindables expand inside env values, including inside `DEVICE_MESSAGING_CONFIG_JSON`. Replace `api` with that component's name and the path with whatever the adopter exposes. HMAC still required when `DEVICE_MESSAGING_WEBHOOK_SECRET` is set.

A laptop running the adopter locally cannot be reached at `localhost` from this component. Use a tunnel, or omit `eventWebhook` and inspect `GET /message/:correlationId` / logs for that test.
