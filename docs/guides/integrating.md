# Integrating

This service takes a command for a device, delivers it, and tells you what happened.
You talk to it over HTTP; it talks back over a webhook.

Live shapes: **`/swagger`** and **`/v3/api-docs`**. This page is the human version.

## Command API

Use `Authorization: Bearer <DEVICE_MESSAGING_API_KEY>`. Unset or empty is for **local
development only** — command and token routes then accept anyone who can reach the port.

In any reachable deployment, set a **non-empty** key, **or** keep the service on a private
network / behind a reverse proxy that authenticates callers. Do not expose those routes to
the internet without one of those.

| You want | Call |
|---|---|
| Send a command | `POST /message/enqueue` |
| See where it is | `GET /message/:correlationId` |
| Drop it before it leaves | `POST /message/cancel` or `POST /messages/cancel` |
| Mint a token now | `POST /token/generate` |

`correlationId` is **your** id. Keep it. That's how you match later events to the job
you created.

`pluginId` chooses the hardware path (`calin-api-v1`, `calin-api-v2`,
`calin-chirpstack`, `nxt-sts`, or a stub). The plugin must be in `plugins[]` or the
request fails clearly — the process does not crash.

Vendor callbacks (ChirpStack, ...) hit `POST /ingress/:pluginId`. That's not your app.

## Delivery events

Set `eventWebhook.url` in the config artifact. We POST JSON there when something
worth telling you happens:

- **First send** — `deliveryStatus: "SENT_TO_NS"`. We handed it to the network.
  Retries of the same command do not fire this again.
- **Done** — `DELIVERY_SUCCESSFUL` or `DELIVERY_FAILED`.
- **Unsolicited** — the device spoke first. No `correlationId`.

Cancel does not notify the webhook. Delivery success is "it reached the device";
`message.response.status` is whether the meter actually executed (`EXECUTION_SUCCESS`
vs `EXECUTION_FAILURE`).

A POST looks like this:

```http
POST /your-hook
Content-Type: application/json
X-Device-Messaging-Event-Id: 01ARZ3NDEKTSV4RRFFQ69G5FAV
X-Device-Messaging-Signature: sha256=<hex>   # only if you set the secret
```

```json
{
  "eventId": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "occurredAt": "2026-08-14T10:00:00.000Z",
  "pluginId": "calin-chirpstack",
  "message": {
    "id": "01MESSAGEULID00000000000000",
    "correlationId": "job-42",
    "commandType": "READ_CREDIT",
    "deliveryStatus": "DELIVERY_SUCCESSFUL",
    "device": {
      "type": "ELECTRICITY_METER",
      "externalReference": "METER-1001"
    },
    "response": {
      "status": "EXECUTION_SUCCESS",
      "data": { "credit": 12.5 }
    }
  }
}
```

Three ids, on purpose:

| Id | Whose |
|---|---|
| `message.correlationId` | Yours (the job) |
| `message.id` | Ours (the delivery record) |
| `eventId` | This notification. Retries of the **same** POST reuse it. |

Treat `eventId` as the idempotency key. Also sent as `X-Device-Messaging-Event-Id`.

## Verify the signature

If `DEVICE_MESSAGING_WEBHOOK_SECRET` is set, every POST is HMAC-SHA256 over the
**exact raw body** (the bytes on the wire — don't `JSON.stringify` again).

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verifyWebhook(secret, rawBody, signatureHeader) {
  const expected = 'sha256=' + createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signatureHeader ?? '', 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
```

No secret → POSTs are unsigned (we warn at boot if a URL is set anyway).
The command API key and the webhook secret are different: one authenticates **you → us**,
the other **us → you**.

## What you should return

**2xx** means you stored it. We retry network errors, 408, 429, and 5xx.
Other 4xx we don't retry. After six attempts (~a minute of backoff) the event sits in a
Redis DLQ for seven days. Your message still succeeded or failed on the device either way —
webhook delivery is a separate concern.

Keep the handler short: persist, 2xx, do the rest later.

## Config you need

| Where | What |
|---|---|
| JSON artifact | `eventWebhook.url` |
| Env | `DEVICE_MESSAGING_WEBHOOK_SECRET` (optional but you want it) |
| Env | `DEVICE_MESSAGING_API_KEY` (optional locally) |

The engine ticks once a second, so duration knobs (`plugins[].tuning`, retry
backoffs, `delivery.messageTtlSeconds`) are most useful as whole seconds.
Sub-second values do not buy finer scheduling.

Knobs and Redis keys: [ADR-003 §6](../architecture/003-public-http-contract.md).
