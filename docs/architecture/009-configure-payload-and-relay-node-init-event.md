# ADR-009: Device state on enqueue, and the relay-node init event

**Date:** 2026-10-29
**Status:** Accepted — amended 2026-10-29 (decision 1). The first draft put the whole
meter-driver-spec configure body on `requestData.payload`. The caller now sends only the value
the command changes, and the device state that command must keep.

> Two additions to the public contract (ADR-003), both needed by the `sparkmeter-sparknet-http`
> plugin (`docs/plans/003-sparkmeter-sparknet-http-plugin.md`). Enqueue gains an optional
> `requestData.deviceState`, and `requestData.payload` gains the `{ powerLimit }` object the
> token route already uses. The outbound webhook gains a second envelope variant that tells the
> adopter a relay node needs init. Existing message events do not change.

**Read this when:** changing `requestDataSchema` or `webhookEventSchema`, adding a webhook event
that is not about one message, or building against the SparkMeter plugin.
**Related:** ADR-003 (public HTTP contract; this ADR amends the `requestData` shape and §6),
ADR-002 (plugin settings hold the fleet configure constants), ADR-004 §6
(`@nxtgrid/device-messaging-contract`), plan 003 design points 4, 5, 8a, and 8b.

---

## Context

**Configure.** meter-driver-spec v1.4 configures a meter with one call,
`POST /v1/nodes/{node_id}/configure-meter`. The body is a command name plus six required fields
(`meter-driver-spec/openapi/meter-driver.yaml` lines 319–345; spec §5.6): `power_limit` (watts),
`current_limit` (amps), `startup_delay` (seconds), `throttle_on_time` (seconds),
`throttle_off_time` (seconds), and `throttle_count_limit`. The call replaces the whole
configuration. It is not a delta.

The command vocabulary on our wire stays `TURN_ON`, `TURN_OFF`, and `SET_POWER_LIMIT`
(plan 003 point 5). A caller should not have to send six vendor fields to turn a meter on.
`power_limit` and the relay are the values that vary per meter and per command. The other four
describe the fleet. Today `requestData` is strict: `token` is optional, and `payload` is only a
`SET_DATE` or `SET_TIME` object (`src/lib/device-message/schemas.ts`). `POST /token/generate`
already takes `{ powerLimit }` for `SET_POWER_LIMIT`, as an anonymous object inside
`generateTokenSchema`.

**Relay-node init.** Point 8a has this service tell the adopter when a basestation needs init,
over the existing `eventWebhook` URL. Point 8b fixes when: after `gateway_status` on that
basestation's event stream goes from `connected` false to `connected` true. Today every webhook
body is one strict envelope whose `message` requires `deliveryStatus` and `device`
(`src/engine/webhook/event-schema.ts`). A basestation needing init is not a message and has
neither.

The basestation id is the value the adopter sends as `device.relayNode.id`. ADR-003 D6 chose
`relayNode` as the generic name for the I/O parent (LoRaWAN gateway, CALIN DCU, mesh hop) and
left vendor nouns to plugins (`relayNodeNoun`, the initial-queue `kind`).

---

## Decisions

### 1. `deviceState`, and one shared power-limit payload

The caller sends the command's own argument on `payload`, and the device state that command
must leave unchanged on `deviceState`. This service stores neither. It does not merge with an
earlier command.

`requestData` gains an optional strict `deviceState`:

```ts
deviceState?: {
  powerLimit?: number;   // watts
  relay?: 'ON' | 'OFF';
}
```

`requestData.payload` gains a third strict variant, `powerLimitPayloadSchema`
(`PowerLimitPayload`): `{ powerLimit: number }`, in watts. The same schema is the `payload` of
`POST /token/generate` when `type` is `SET_POWER_LIMIT`. That route's JSON does not change; the
object stops being anonymous. A caller can build one `PowerLimitPayload` and pass it to either
route.

The core schema does not tie these fields to a `commandType` or a `pluginId`. `token`,
`payload`, and `deviceState` stay optional, as `token` and `payload` are today. Each plugin's
`validateEnqueue` requires what it needs.

`sparkmeter-sparknet-http` requires:

| `commandType` | `payload` | `deviceState` |
|---|---|---|
| `TURN_ON`, `TURN_OFF` | absent | `powerLimit` required, `relay` absent |
| `SET_POWER_LIMIT` | `PowerLimitPayload` | `relay` required, `powerLimit` absent |

A missing required field fails enqueue. A field the command forbids fails enqueue the same way.
Zero is a real `powerLimit`. The CALIN plugins do not read `deviceState`. A CALIN
`SET_POWER_LIMIT` enqueue still carries the minted string on `requestData.token` and does not
carry `PowerLimitPayload`.

The plugin posts the spec body. It derives the spec command: `TURN_ON` posts
`ElectricalMeterCommandEnable`, `TURN_OFF` posts `ElectricalMeterCommandDisable`, and
`SET_POWER_LIMIT` posts `Enable` when `relay` is `ON` and `Disable` when `relay` is `OFF`.
`power_limit` comes from the caller's `powerLimit`. The other four fields come from the plugin
settings `meterConfiguration` (ADR-002, non-secret):

| Setting | Unit | When omitted |
|---|---|---|
| `currentLimit` | amps | 200 |
| `startupDelay` | seconds, uint32 | fails boot |
| `throttleOnTime` | seconds, uint32 | fails boot |
| `throttleOffTime` | seconds, uint32 | fails boot |
| `throttleCountLimit` | uint32 | fails boot |

200 A is the largest inrush ThunderCloud seeds (SM200E), on the spec's amp scale. It does not
protect a smaller model. The operator overrides `currentLimit` with that model's inrush. A
present zero is a real cap, not the default. The plugin maps these keys to the spec's snake_case
names when it posts. `node_id` is `device.externalReference` (plan 003 point 7) and is not in
`requestData`.

The in-flight message holds what the caller sent. A retry assembles the same spec body. After
the command is terminal, that body is gone with the message.

`@nxtgrid/device-messaging-contract` exports `DeviceState`, `PowerLimitPayload`, and their
schemas.

Implemented by plan 003 checklist item 2.

### 2. A second webhook envelope: the relay-node event

`WebhookEvent` becomes a union of two strict variants. They share `eventId`, `occurredAt`, and
`pluginId`. Each has exactly one of `message` or `relayNode`.

**Message event** — unchanged, byte for byte:

```ts
{ eventId: string; occurredAt: string; pluginId: string; message: WebhookMessage }
```

**Relay-node event** — new:

```ts
{
  eventId: string;
  occurredAt: string;
  pluginId: string;
  relayNode: {
    id: number;               // uint32, the adopter's device.relayNode.id
    status: RelayNodeStatus;  // 'INIT_REQUIRED'
  };
}
```

- **Tell them apart by key.** `'message' in event` narrows the TypeScript union. The schema is a
  `z.union`, not a `z.discriminatedUnion`; there is no top-level `type`.
- **`RelayNodeStatus` is a closed enum** with one value today, `INIT_REQUIRED`. As with
  `deliveryStatus` (ADR-003 §6), consumers ignore values they do not know. A later value is an
  amendment to this ADR, not a new envelope.
- **`INIT_REQUIRED` means:** this relay node lost its session; call `initBasestation`, then
  `registerMeters`, then enqueue a configure for each meter (plan 003 point 8b). For
  `sparkmeter-sparknet-http` it fires when `gateway_status.connected` goes false then true. An
  event-stream reconnect alone does not fire it.
- **Every occurrence is a new event** with a new `eventId`. A gateway that flaps twice sends two
  events. The adopter treats each as a fresh request to init and register.
- **Left out on purpose:** the relay node's `baseUrl` (operator topology), the `gateway_status`
  diagnostics (firmware, gateway type; they go to logs), and a trigger reason (there is one
  trigger).
- **Delivery is unchanged.** Same URL, headers, signing, retry, and dead-letter rules as message
  events (ADR-003 §6).
- Only `sparkmeter-sparknet-http` emits this event in v1. Its local noun for the relay node is
  "basestation" (`settings.basestations`, `relayNodeNoun: 'basestation'`); the wire says
  `relayNode`.
- `@nxtgrid/device-messaging-contract` exports `WebhookMessageEvent`, `WebhookRelayNodeEvent`,
  and `RelayNodeStatus`. `WebhookEvent` is the union. `WebhookMessage` becomes
  `WebhookMessageEvent['message']`, the same type as today. OpenAPI `webhooks` documents both
  variants.

How a plugin hands this event to the engine is an engine seam and is not decided here. It is
settled with the event-stream seam (plan 003 item 3, ADR-010) or with init gating (item 10).

Implemented by plan 003 checklist item 10.

---

## Consequences

### Positive

- `TURN_ON` carries one number. `SET_POWER_LIMIT` carries the new limit and the relay position
  to keep. Callers that never send `deviceState` are unchanged, including every CALIN enqueue.
- One `PowerLimitPayload` serves the CALIN token mint and the SparkMeter configure.
- One webhook URL still carries everything; there is no second callback to configure or sign.
- The relay-node block can carry later statuses for any relay node (a CALIN DCU, a gateway)
  without another envelope change.

### Negative / Risks

- An adopter on an older contract package that enables this plugin rejects relay-node events,
  because the old envelope is strict, and rejects enqueue bodies that include `deviceState`,
  because `requestData` is strict. Upgrade the package before enabling the plugin.
- Telling webhook variants apart by key is less explicit than a `type` tag.
- Readings come back in `response.data` with the spec's snake_case names (plan 003 point 5).
  `response.data` is plugin-owned, so this is accepted.
- The plugin assembles a six-field spec body from the caller and from settings, and maps those
  keys to snake_case. A mistake there is a silent wrong field, so it needs a unit test.
- An omitted `currentLimit` posts 200 A. That will not trip the largest seeded model, and it
  will not protect a smaller one.

## Rejected

- **The whole spec configure body on `requestData.payload`.** The first draft of decision 1,
  withdrawn the same day. The caller would have sent the spec command name and all six fields.
  That breaks the command vocabulary: `TURN_ON` would carry vendor fields the caller does not
  otherwise know.
- **Putting the preserved state inside `payload`.** `payload` stays the command's own arguments.
  A `TURN_ON` with `{ powerLimit }` would read as "turn on and set the limit."
- **Remembering the last relay and power limit in this service.** The caller holds that state
  and sends it on the command.
- **`startupDelay` per meter.** A different delay per meter could stagger inrush. It stays a
  fleet setting. ThunderCloud sends 0.
- **`currentLimit` defaulting to 65535.** That is ThunderCloud's cap when it sends scaled
  register units rather than amps. On the spec's amp scale, 200 is the largest seeded model.
- **A top-level `type` on every webhook event.** A true discriminated union, but every existing
  event gains a required key, and adopters validating with today's strict schema reject all
  events until they upgrade.
- **`basestation` as the wire name.** It names one kind of box rather than the role.
  Renaming `relayNode` across the wire, the engine stage, Redis keys, tuning keys, and Skyfox's
  client is a separate ADR-003 amendment if ever wanted.
- **Carrying `gateway_status` details or `baseUrl` in the event.** Diagnostics and topology, not
  something the adopter acts on.

## Triggers (revisit when)

- A second plugin needs `deviceState`.
- A deployment needs a different `startupDelay` per meter.
- A second plugin needs a relay-node status other than `INIT_REQUIRED`.
- A non-message event appears that is not about a relay node.
- SparkMeter confirms `query_provider_status` / `uptime_ms` (plan 003 question 4), and a process
  restart becomes a second trigger for `INIT_REQUIRED`.
- A real basestation shows that `current_limit` is scaled register units rather than amps.
