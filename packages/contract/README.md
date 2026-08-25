# `@nxtgrid/device-messaging-contract`

TypeScript types and Zod schemas for the
[nxt-device-messaging](https://github.com/nxtgrid/nxt-device-messaging) HTTP command API
and outbound event webhook.

This is the wire contract (ADR-003), not an HTTP client and not the plugin SPI.
Ingress (`POST /ingress/:pluginId`) is vendor→service and is not exported.

**Peer:** [`zod`](https://www.npmjs.com/package/zod) `^4.4.3` (needed at typecheck and
for `.parse()`).

```bash
pnpm add @nxtgrid/device-messaging-contract zod
```

```ts
import {
  createDeviceMessageSchema,
  webhookEventSchema,
  type CreateDeviceMessage,
  type WebhookEvent,
} from '@nxtgrid/device-messaging-contract';

const body: CreateDeviceMessage = createDeviceMessageSchema.parse(req.body);
const event: WebhookEvent = webhookEventSchema.parse(req.body);
```

Human integration guide (auth, webhook HMAC, event set):
[integrating.md](https://github.com/nxtgrid/nxt-device-messaging/blob/main/docs/guides/integrating.md).
Live shapes: the running service’s `/swagger` and `/v3/api-docs`.

License: MPL-2.0 (same as the service).
