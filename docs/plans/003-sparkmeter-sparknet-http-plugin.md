# Plan 003 — `sparkmeter-sparknet-http` plugin

**Status:** design accepted — 2026-10-29 (points 1–11, including 8a and 8b). Points 3, 4, 10,
and 11 amended the same day after question 7. Building, one checklist item at a time.
**Branch:** `plugin/sparkmeter-sparknet-http`.
**Supersedes nothing.**

This file is the design record and the build plan. The **Checklist** is the work. The **Design
points** are what each item cites.

This plan builds a delivery plugin that **replaces ThunderCloud** as the command client of
[sparknet-http](https://github.com/EarthSpark/sparknet-http), the vendor's meter driver. The
driver implements [meter-driver-spec](https://github.com/EarthSpark/meter-driver-spec) v1.4.
sparknet-http is the SparkMeter software we expect to keep. ThunderCloud does not run beside
this service.

We develop against [meter-driver-emulator](https://github.com/EarthSpark/meter-driver-emulator)
(see [`docs/guides/sparkmeter-sparknet-http.md`](../guides/sparkmeter-sparknet-http.md)). The
target is always a real sparknet-http on a real grid. When the emulator and the real driver
differ, design for the real driver and note the gap.

---

## Who reads what

*Reader: both.*

Each section below opens with a reader tag.

| Reader | Meaning | Sections |
|---|---|---|
| **Maintainer** | Acts on it: decides, sends, or confirms. An AI agent does not. | Questions for SparkMeter |
| **AI agent** | Operating instructions. The maintainer can skip them. | How to pick this up cold |
| **Both** | Shared record. The maintainer decides; an AI agent proposes and keeps it current. | Everything else |

---

## How to pick this up cold

*Reader: AI agent.*

1. Read this file top to bottom. It is self-contained.
2. Read the guide above, then `src/plugins/plugin.interface.ts`.
3. Take the first open **Checklist** item and read the design points it cites.
4. Before changing any file, post a short summary of what the item will do and which files it
   touches, and name the item's model from the Checklist. If you are not that model, say so.
   Wait for the maintainer's go. This holds after a handoff prompt too.
5. Do that item only, then stop for review. If it raises a design question, recommend an answer
   and wait for the maintainer to accept it before coding past it.
6. After the item is reviewed, recommend whether to continue in this chat or start a new one,
   and say why. If a new one, write the handoff prompt.

Evidence below cites files and lines as of 2026-10-26. If it no longer matches, say so and stop.

### Rules of engagement

- **The maintainer reviews and commits. Always.** Never commit, amend, or push.
- **One point at a time.** Ask questions one at a time, inline in the chat.
- **Look facts up first.** The workspace holds `meter-driver-spec`, `sparknet-http` (README and
  packaging only; the binary is closed source), `thundercloud` (SparkMeter's current client for
  this driver), and `skyfox` (our caller: Tiamat `apps/tiamat/src/modules/meter-interactions/`).
  Ask SparkMeter only what those cannot answer.
- **This plugin replaces ThunderCloud.** sparknet-http stays. ThunderCloud is not a co-client,
  not a fallback, and not the behavior to copy. Mold the driver to our commands. Our caller
  sends one read, write, setting, or token command at a time.
- **Summary and model before code.** Every item starts with a summary and the Checklist's model
  (step 4 above). Claude Opus 5.5 takes items that need judgment: ADRs, engine seams, and items
  that settle open questions. Grok 4.7 takes items whose design is already fixed. The column is
  a cost decision.
- **Save context.** After each item, weigh staying in the chat against a new one. Prefer a new
  chat when the next item has a different model, touches a different part of the code, or this
  chat is long. A handoff prompt names the next item, its model, the files to read, and anything
  learned that is not yet in this file. It goes in a ` ```text ` block, prompt text only.
- Update the **Checklist** and **Session notes** when an item lands. When an item changes an
  accepted design point, update that point's wording and say so in the note.

---

## Checklist

*Reader: both.*

Ordered. Every code item ships with its unit tests and runs against the emulator. An ADR item
is written and accepted before the item that implements it.

| # | Item | Design points | Depends on | Model | Status |
|---|---|---|---|---|---|
| 1 | **ADR-009** — public contract additions: `requestData.deviceState` and a shared `{ powerLimit }` payload, and the "basestation needs init" webhook event | 4, 8a, 8b | — | Claude Opus 5.5 | ☑ |
| 2 | **Skeleton** — catalog entry, `settings.basestations`, `settings.meterConfiguration`, one initial queue per basestation, `supportedCommandTypes`, `validateEnqueue`, `externalReference` parsing, `sendOne` posting configure. Interim admission `concurrency` with `maxInFlight: 1`. Emulator service in `docker-compose` | 4, 5, 6, 7, 8a | 1 | Grok 4.7 | ☐ |
| 3 | **ADR-010** — plugin-owned event stream on `PushPlugin` (`start`, `deliver`, `dropped`) | 2 | — | Claude Opus 5.5 | ☐ |
| 4 | **ADR-008 amendment** — a plugin may end the device stage without retry. This plugin's `deviceInFlightTimeoutMs` expiry is `DELIVERY_FAILED` and does not post configure again. ChirpStack keeps `retryOrFail` | 11 | — | Claude Opus 5.5 | ☐ |
| 5 | **Event stream** — the engine seam, the SSE client and frame parser, configure accepted / applied / invalid matched on `{pluginId}:{nodeId}` with point 10's statuses. `applied` completes the command only when the six echoed fields match the posted body; a mismatch counts as unmatched. Readings as `READ_REPORT`. Device-timeout expiry is terminal, per item 4. Development tuning values (not production). A metric for events that matched no message | 2, 3, 5, 10, 11 | 2, 3, 4 | Claude Opus 5.5 | ☐ |
| 6 | **ADR-011** — per-meter hold admission and the basestation queue gate | 6, 8a, 8b | — | Claude Opus 5.5 | ☐ |
| 7 | **Admission** — send lock, meter hold, the pick walk, and the gate the plugin opens and closes. Replaces the interim `concurrency` | 3, 6 | 5, 6 | Claude Opus 5.5 | ☐ |
| 8 | **Reconnect** — reopen a dropped stream with backoff; gate closed while it is down; a stream-connected gauge per basestation | 8a | 7 | Grok 4.7 | ☐ |
| 9 | **Provisioning** — `initBasestation`, `registerMeters`, `unregisterMeters` on the existing `provisioning.execute`. Settles the init path, the send lock, and long register calls | 8a | 2 | Claude Opus 5.5 | ☐ |
| 10 | **Init gating** — `gateway_status` false closes the gate and true sends the webhook; init and register accepted reopen it | 8b | 1, 7, 9 | Grok 4.7 | ☐ |
| 11 | **Smokes and docs** — httpYac smokes, integration tests on Valkey, guide update including deadline sizing | 11 | 10 | Grok 4.7 | ☐ |
| 12 | **Real basestation trial** — an operator-provided reachable `baseUrl` (point 9), real deadlines, confirm the event names and the unregistered-meter answer | 9, 10, 11 | 11, questions 6 and 7 | Claude Opus 5.5 | ☐ |

### Why this order

The contract comes first because the enqueue shape and the webhook body are what Skyfox builds
against. The device-timeout amendment comes before the event stream, which implements it. The
event stream comes before admission so a command runs end to end early. Until item
7, `concurrency` with `maxInFlight: 1` per basestation queue stands in for the meter hold. It is
stricter than the design but releases on `enterRetry`, so a second command for the same meter
can go during a retry wait. That is acceptable against the emulator and not on a real grid.
The production device wait (point 11) is chosen at the real-basestation trial. Question 7 is
answered: the driver does not give up, so the number is how long we wait.
Checklist item 12 needs an operator-provided reachable `baseUrl` (point 9).

---

## Deployment assumption

*Reader: both. Set by the maintainer.*

This plugin exists to replace ThunderCloud, and to replace as many of the other moving
SparkMeter software parts as we can. The aim is to sit as close to the meter as the contract
allows. The part we expect to keep is sparknet-http on the basestation. Hopefully that is the
only SparkMeter software left in the path.

ThunderCloud does not run at the same time as this service. They do not share a sparknet-http,
and they do not take turns on one. A grid that this service commands is no longer commanded
by ThunderCloud.

We do not replicate ThunderCloud's way of working. Its client, its events, and its reconcile
are evidence of what the driver does. Where that way differs from ours, we mold it to ours.
The caller is Tiamat's meter-interactions module
(`skyfox/apps/tiamat/src/modules/meter-interactions/`). An interaction there is one
fine-grained command: a read (`READ_VOLTAGE`, `READ_POWER`, …), a control (`TURN_ON`,
`TURN_OFF`), a write (`SET_DATE`, `SET_TIME`), or a token (`TOP_UP`, `SET_POWER_LIMIT`,
`CLEAR_CREDIT`, `CLEAR_TAMPER`, `DELIVER_PREEXISTING_TOKEN`). The digital twin and the
wallet stay in that caller. This service delivers the command and forwards readings.
Which of those commands this plugin accepts is the design points below, not ThunderCloud's
list. Tiamat's `TOP_UP` is this service's `TOP_UP_KWH`.

Scope is legacy sites only, and only sites with a single basestation. That basestation is one
sparknet-http and one event stream. Meters relay to it over the mesh. A second basestation on
the same site is out of scope.

---

## Established facts

*Reader: both. An AI agent cites these as evidence; the maintainer can spot-check them.*

Checked against the repos in the workspace. Each fact names where it came from.

**Transport**

- HTTP plus the SSE stream `GET /v1/events` is the required profile. gRPC is section 7,
  "Optional gRPC Profile". (`meter-driver-spec/docs/spec/index.md` lines 50–63, 387–408.)
- The gRPC event stream has no resume: `SubscribeEventsRequest {}` is empty.
  (`meter-driver-spec/proto/meter_driver.proto` line 339.) The emulator ignores `Last-Event-ID`
  on SSE. Neither transport can replay missed events.
- ThunderCloud defaults to HTTP; gRPC is an operator choice with the same semantics.
  (`thundercloud/sparkmeter/metering/runtime_client.py` lines 279–292.) Its gRPC init needs fixed
  fields, while HTTP init posts whatever `/v1/requirements` asks for (same file, lines 45–49).
- The sparknet-http image binds gRPC by default (`SPARKNET_HTTP_GRPC_BIND=0.0.0.0:50051`). Its
  README names the service `tc2.meter_driver.v1.MeterDriverControl`; the spec requires the
  package to be exactly `meter_driver.v1` since spec 1.2.0. Unverified which one the binary
  registers. (`sparknet-http/README.md` lines 108–114, 158; `meter-driver-spec/CHANGELOG.md`
  line 21.)

**Driver state and recovery**

- The driver keeps no durable per-meter state across restarts. ThunderCloud's reconcile module
  says so and re-sends init, register, configure, and balance for every meter on every boot.
  (`thundercloud/sparkmeter/metering/reconcile.py` lines 1–17, 62–125.) SparkMeter confirmed it
  (question 1).
- ThunderCloud only commands sparknet-http from the same box. Its metering lifespan is a no-op
  in the cloud. (`thundercloud/sparkmeter/metering/lifespan.py` lines 310–317.) There is no
  prior art for a client that reaches sparknet-http over a network link.
- The cloud reaches the site by syncing with the ground system, not by calling the driver.
  ThunderCloud 1.x, what runs in the field, has the grid-edge unit dial the cloud over cellular
  with a custom binary TCP protocol; the cloud runs the TCP server.
  ([Elixir blog, 2023-03-09](https://elixir-lang.org/blog/2023/03/09/embedded-and-cloud-elixir-at-sparkmeter/).)
  ThunderCloud 2.0 syncs the ground and cloud Postgres databases with SymmetricDS, and only the
  ground webapp talks to the driver, at a base URL registered in its settings.
  (`thundercloud/README.md` lines 112–135.)
- `POST /v1/init` clears every meter. (Guide, "Init clears every meter".)
- When the event stream ends or breaks, ThunderCloud treats the driver as restarted and re-runs
  the full init and reconcile. (`thundercloud/sparkmeter/metering/lifespan.py` lines 330–380.)
- ThunderCloud does not match acknowledgement events to commands. It only logs
  `electrical_meter_configuration_accepted`, `_applied`, and
  `invalid_electrical_meter_configuration`. (`thundercloud/sparkmeter/metering/events.py`
  lines 57–86.) Per-command tracking is new ground for this plugin.

**Access, events, and modes**

- Neither the spec nor the sparknet-http README defines client authentication. Whoever reaches
  the HTTP port can init, register, and configure. Init carries `aes_key` in the request body.
  (`meter-driver-spec/docs/spec/index.md`; `sparknet-http/README.md`.)
- The wire names are the OpenAPI constants: `electrical_meter_configuration_accepted`,
  `electrical_meter_configuration_applied`, and `invalid_electrical_meter_configuration`.
  (`meter-driver-spec/openapi/meter-driver.yaml` lines 674–688; the proto uses the same names.)
  The shorter names in the prose event table (`meter_configuration_accepted`, and the rest)
  are not wire names. ThunderCloud says so and only recognizes the OpenAPI constants.
  (`thundercloud/sparkmeter/metering/events.py` lines 57–77;
  `meter-driver-spec/docs/spec/index.md` lines 233, 332–333.)
- The spec does not say what configure-meter does for a node that is not registered. It names
  an unknown-node event only for unregister (`node_to_unregister_unknown`).
  (`meter-driver-spec/docs/spec/index.md` lines 209–235.)
- The spec has no endpoint that shows what the driver still holds for a meter.
  (`meter-driver-spec/docs/spec/index.md` lines 50–63.)
- SparkMAC-tools mode, enabled over HTTP on site, pauses normal scheduled meter activity.
  (`sparknet-http/README.md` lines 116–132.)

**Differences between the emulator and a real driver**

- Init path: the spec and emulator use `POST /v1/init`; the sparknet-http README documents
  `POST /v1/sparknet/init`. A real driver can require `channel` on init.
- On a real driver, `configuration_applied` waits on the mesh, and `gateway_status.connected`
  can be false. The emulator shows neither.

---

## Design points

*Reader: both. The maintainer accepts or rejects; an AI agent recommends and updates the table.*

Proposed by the maintainer on 2026-10-26. Points 9–11 added 2026-10-29 from a gap review.
Resolve one at a time, in order unless a dependency says otherwise.

| # | Point | Status |
|---|---|---|
| 1 | Transport: HTTP and SSE per meter-driver-spec. gRPC deferred. | ☑ accepted 2026-10-26 |
| 2 | The engine needs a seam for an event stream the plugin owns. `incoming.handle` is only fed by HTTP ingress today. | ☑ accepted 2026-10-27 |
| 3 | Correlation: one in-flight command per `node_id`. Next command only after the previous is terminal. An `applied` event also has to match the six posted fields. | ☑ accepted 2026-10-27, amended 2026-10-29 |
| 4 | Caller sends the value the command changes, and the state it must keep, on `requestData`. Fleet constants live in plugin settings. This service keeps no desired configuration. | ☑ accepted 2026-10-27, amended 2026-10-29 |
| 5 | First commands: `TURN_ON`, `TURN_OFF`, `SET_POWER_LIMIT`. No enqueued reads. Unsolicited readings are `READ_REPORT`. `SET_BALANCE` deferred, see below. | ☑ accepted 2026-10-27 |
| 6 | One ready queue per basestation. One HTTP call at a time, and one command per meter until it is terminal. | ☑ accepted 2026-10-28 |
| 7 | `externalReference` is the decimal digits of `node_id`. Skyfox derives that from the serial and matches it back. | ☑ accepted 2026-10-28 |
| 8a | The adopter owns each basestation's session through provisioning operations (`initBasestation`, `registerMeters`, `unregisterMeters`). This service keeps no meter list and no init payload, holds basestation URLs in plugin settings, reconnects the stream, and tells the adopter when a basestation needs init. | ☑ accepted 2026-10-28 |
| 8b | Ask the adopter to init only after `gateway_status.connected` goes false then true. Hold that queue until the following init and register are accepted. An SSE reconnect alone does not ask for init. | ☑ accepted 2026-10-29 |
| 9 | Reaching a basestation is outside this service. The plugin is a plain HTTP client of `baseUrl`; a private encrypted route is the only access control in v1. | ☑ accepted 2026-10-29 |
| 10 | Stage mapping: which delivery status each driver answer and event sets, and what ends a command. `applied` must match the six posted fields. | ☑ accepted 2026-10-29, amended 2026-10-29 |
| 11 | Stage deadlines: which timeout covers which gap. The device wait is operational. Expiry does not resend. The trial sets the number. | ☑ accepted 2026-10-29, amended 2026-10-29 |

### Point 1 — accepted wording

> The plugin uses HTTP and SSE as defined in meter-driver-spec. gRPC is deferred. Reopen it only
> when there is a need HTTP and SSE cannot meet, such as a driver that ships gRPC only, **and** the
> driver's service matches `meter_driver.v1.MeterDriverControl` as the spec requires. The
> transport stays inside the plugin, so adding gRPC later does not touch the engine.

Reopen point 1 if SparkMeter's answers (below) show that gRPC has a resume or replay mechanism
that SSE lacks.

### Point 2 — accepted wording

> The plugin stays PUSH. The engine adds an optional `start` on a PushPlugin, called once from
> the composition root, and only this plugin implements it. The plugin holds `GET /v1/events`
> open and parses frames itself. It hands each parsed event to `deliver`, the same shape
> `incoming.handle` returns for ChirpStack, and the engine applies it with `processEvent`.
> `incoming.handle` stays the HTTP ingress parser and may be omitted when `start` is present;
> ingress then rejects that plugin. If the stream fails to open, ends, errors, or stalls, the
> plugin calls `dropped` once and leaves the stream down. The engine records that and does
> nothing further. Reconnect and recovery belong to points 4 and 8. In-flight messages keep
> their stage deadlines. The delivery statuses are unchanged.

Point 8a (2026-10-28) fills in the reconnect: the plugin reopens a dropped stream with backoff
instead of leaving it down.

### Point 3 — accepted wording

> One command per `node_id` owns the match until that command succeeds or fails for good.
> `sendOne` returns `{pluginId}:{nodeId}`, and `configuration_accepted`, `configuration_applied`,
> and `invalid_electrical_meter_configuration` echo it through the existing `deliveryQueueId`
> index. A retry is still that command: the next command for that `node_id` stays in the ready
> queue until this one is terminal. Readings are unsolicited and carry no `deliveryQueueId`.
> Point 6 enforces the one-in-flight rule. No new lookup and no new SPI method. An `applied`
> event completes this command only when its six configuration fields also match the body this
> command posted (point 10). `node_id` alone can attach a late `applied` to the next command.

There is no `networkServerRef` in this repo, the spec, or ThunderCloud. The stream belongs to
one plugin instance. The event carries `node_id` and, on `applied`, the six configuration
fields. It carries no request id, so the plugin id is the scope the plugin can rebuild when a
frame arrives. SparkMeter confirmed there is no echoed request
field (question 3, answered 2026-10-27). The one-command-per-`node_id` rule stands.

A configure the caller sends later, including one sent for recovery under point 8, uses the same
rule: the meter's current command must be terminal before that id is minted again.

### Point 4 — accepted wording

Amended 2026-10-29. The original wording put the whole spec body on the enqueue. The caller now
sends two things, and the plugin fills the spec body. ADR-009 decision 1 records the wire. The
same day, question 7: a retry after `electrical_meter_configuration_accepted` does not happen.

> The caller sends the command's own argument on `requestData.payload`, and the device state that
> command must leave unchanged on `requestData.deviceState`. This service stores neither, fills
> nothing from an earlier command, and keeps no desired configuration.
>
> `deviceState` is `{ powerLimit?: number, relay?: 'ON' | 'OFF' }`. `powerLimit` is watts.
> `payload` gains `{ powerLimit: number }`, the same object `POST /token/generate` already uses
> for `SET_POWER_LIMIT`. The core schema leaves `token`, `payload`, and `deviceState` optional.
>
> This plugin requires `deviceState.powerLimit` on `TURN_ON` and `TURN_OFF`, and forbids `relay`
> and `payload` there. It requires `payload` of `{ powerLimit }` and `deviceState.relay` on
> `SET_POWER_LIMIT`, and forbids `deviceState.powerLimit` there. A missing required field fails
> enqueue. A forbidden field fails enqueue the same way. Zero is a real power limit.
>
> The plugin posts `POST /v1/nodes/{node_id}/configure-meter`. `TURN_ON` posts
> `ElectricalMeterCommandEnable`, `TURN_OFF` posts `ElectricalMeterCommandDisable`, and
> `SET_POWER_LIMIT` posts `Enable` when `relay` is `ON` and `Disable` when `relay` is `OFF`. `power_limit` is the
> caller's `powerLimit`. The other four spec fields come from the plugin settings
> `meterConfiguration`: `currentLimit` (amps, 200 when the key is omitted), `startupDelay`,
> `throttleOnTime`, `throttleOffTime`, and `throttleCountLimit`. Those four are required. A
> missing one fails boot. A present zero is a real value. The plugin maps the keys to the spec's
> snake_case names when it posts.
>
> The in-flight message holds what the caller sent. A retry before
> `electrical_meter_configuration_accepted` assembles the same spec body. After that event the
> command does not retry (point 11). After the command is terminal, that body is gone with the
> message. A later reading that disagrees is
> the caller's reason to enqueue a new command. `node_id` is the device address (point 7). A node
> roster and an init payload stay in point 8.

`requestData` cannot carry `deviceState` today, and `payload` is only a date or a time.
`SET_POWER_LIMIT` on the token route already takes `{ powerLimit }`; enqueue does not, until
item 2 names that schema and reuses it. A CALIN enqueue of `SET_POWER_LIMIT` still carries
`requestData.token` and does not carry this payload. The CALIN plugins do not read
`deviceState`.

### Point 5 — accepted wording

> The plugin's `supportedCommandTypes` are `TURN_ON`, `TURN_OFF`, and `SET_POWER_LIMIT`.
> Any other enqueue command type fails the existing membership check. `READ_REPORT` is not
> enqueueable.
>
> `validateEnqueue` enforces point 4's table. The spec command is not on the wire. The plugin
> derives it: `TURN_ON` posts `ElectricalMeterCommandEnable`, `TURN_OFF` posts
> `ElectricalMeterCommandDisable`, and `SET_POWER_LIMIT` posts `Enable` when `relay` is
> `ON` and `Disable` when `relay` is `OFF`. `Reboot`, `CalibrateStart`, `CalibrateFinish`,
> and `EnableSts` are never posted. The spec has no power-limit command. `power_limit` is one of the six
> fields the plugin assembles, so `SET_POWER_LIMIT` is the caller's label and the relay verb
> comes from `deviceState.relay`. A `TURN_ON` carries `deviceState.powerLimit` and no relay.
>
> `electrical_meter_reading` and `electrical_meter_reading_phased` are unsolicited
> `READ_REPORT` events on the existing path: `deliveryStatus` `DELIVERY_SUCCESSFUL`,
> `response.status` `EXECUTION_SUCCESS`, and no `deliveryQueueId`. An in-flight command is
> left alone. The closed command set does not grow. `response.data` is the spec reading
> fields except `node_id`: `period_start`, `period_end`, `state`, `frequency`,
> `current_avg`, `current_min`, `current_max`, `voltage_avg`, `voltage_min`,
> `voltage_max`, `true_power_avg`, `true_power_inst`, `apparent_power_avg`,
> `power_factor_avg`, `energy`, `uptime_secs`, and `user_power_limit`. `state` stays the
> spec integer. `period_start` and `period_end` stay unix-second uint32s. A phased event
> also carries that event's per-phase fields, `phases`, and `computed_fields_version`.
> `node_id` is copied back as the decimal digits of `externalReference` (point 7). A
> frame missing a required base field is not emitted. A present zero is forwarded. Unknown
> keys are not copied. Whether this service sets `request_phased_readings` stays in point
> 8. The spec emits the phased event in place of the single-phase event when phased
> readings were requested.

SparkMeter confirmed 2026-10-29 that they do not use or support meters in STS mode (question 5).
The plugin never posts `ElectricalMeterCommandEnableSts`. The meter does have an internal clock.
sparknet-http puts the current time and the heartbeat timing in its outgoing protocol packets,
and the meter firmware sets its clock from those. This service does not set the time.
A reading cannot confirm the six configuration fields (question 7). `user_power_limit` is only
the power limit. The in-flight command stays untouched.

### Point 6 — accepted wording

> One ready queue per basestation:
> `queue:sparkmeter-sparknet-http:basestation:{basestationId}`. The caller assigns that id
> on `device.relayNode.id`. A missing id fails enqueue. A pass picks every basestation
> queue, so two basestations proceed together. Each has its own send lock and its own meter
> holds. v1 still has one basestation per site.
>
> The plugin declares one new admission strategy with no knobs. `spacing` and `concurrency`
> stay as they are on the other plugins. There is no new plugin method. The delivery id
> stays `{pluginId}:{nodeId}`.
>
> The send claim is one `sendOne` at a time for that basestation. The string
> `send_lock:sparkmeter-sparknet-http:basestation:{basestationId}` holds the message id. It
> is taken when that message is picked and removed when the HTTP call settles. It expires
> at `nsInFlightTimeoutMs`. It does not wait for accepted, applied, invalid, or timeout.
>
> The meter claim lasts from the pick until the command is terminal, including the retry
> wait. `enterRetry` leaves it in place. The key is the meter and the value is the message
> that owns it:
> `meter_hold:sparkmeter-sparknet-http:basestation:{basestationId}:{deviceAddress}`. The
> message hash records that key, and terminal cleanup deletes it. The device address is
> `externalReference`. Its spelling is point 7.
>
> The pick walks that basestation's ready queue in priority order and removes the first
> message whose meter has no hold, or whose hold value is that same message. Any other
> command for a held meter stays in the queue and does not spend the turn. The walk reads
> the hold for the candidate's own meter. It does not scan the meters currently in use.
> Designing this strategy keeps a long run of commands for held meters from repeating that
> work without bound on every pass.

Point 2 calls `start` once. Inside that call this plugin holds one `GET /v1/events` per
basestation.

Point 8a (2026-10-28) adds one condition to the pick: a basestation whose event stream is down
is skipped.

Point 8b (2026-10-29) adds another: from `gateway_status` `connected` false until
`initBasestation` and the following `registerMeters` for that basestation have both been
accepted, the queue is skipped.

### Point 7 — accepted wording

> `device.externalReference` is the decimal digits of `node_id`, the same integer
> sparknet-http is called with and the same integer events return. For a SparkMeter meter
> that integer is ThunderCloud `meter.code` (0–65535), derived from the printed serial.
> Skyfox keeps the serial, derives the code, and matches a returning code to the meter.
> This service does not parse serials and does not store a serial-to-code map.
>
> On the way down the plugin reads the string as a base-10 integer and posts it as
> `node_id`. A string that is not a base-10 integer in the spec's uint64 `node_id` range
> fails enqueue. The 16-bit derivation check stays in Skyfox. On the way up the event's
> `node_id` is written back as decimal digits with no padding. The meter-hold address from
> point 6 is this string.

### Deferred — `SET_BALANCE`

Not in v1. Decided 2026-10-27. This is the place to pick it up. It is not an STS top-up.

**What it would implement.** A new enqueue command. The caller sends the absolute wallet
total and the low-balance flag. The plugin posts `POST /v1/nodes/{node_id}/balance-and-flags`
(spec §5.8) and the command ends on `electrical_meter_balance_and_flags_accepted` (`node_id`
only) or on timeout. There is no applied event. The post replaces the meter's cached balance.
It does not add a delta, and it does not mint a token. `TOP_UP_KWH`, `CLEAR_CREDIT`, and
`CLEAR_TAMPER` are STS keypad tokens. This driver has no token field. Tamper is reading
`state` 13, and the spec has no clear-tamper call. SparkMeter confirmed 2026-10-29 that they
do not use or support meters in STS mode (question 5).

**Why it was deferred.** The caller holds the wallet and bills cumulative `energy`
(`new energy − last energy`). Supply on or off is `TURN_ON` or `TURN_OFF`. A payment while
the meter is already enabled needs no command here. Spec §5.8 calls the endpoint a cache
update for a balance-aware meter and marks it recommended. ThunderCloud still pushes that
cache on a vend, after a reading, and on reconcile (`send_set_config`, `process_reading`).
The published spec does not say the meter displays the cache or opens the relay from it.
The relay packet this plan can see is configure enable or disable.

Reopen it if SparkMeter confirms the firmware uses the cache (a customer display, or supply
that stays off while the cache is zero even after configure enable), or if a deployment must
keep the cache in step with ThunderCloud.

### Point 8a — accepted wording

Vocabulary. A **basestation** is one sparknet-http process, the radio gateway it drives over
serial, and its one event stream. Meters reach the gateway over the radio mesh. The **adopter** is
the system above this service; it holds the meters per basestation. meter-driver-spec calls
sparknet-http "the driver"; this plan says sparknet-http when it means the process.

> The adopter owns each basestation's session. It holds that basestation's meter list and init
> values, and calls three provisioning operations on this plugin (`POST /plugin/provisioning`).
> Each payload names the basestation id.
>
> - `initBasestation` forwards the init body unchanged to that basestation's sparknet-http. The
>   body is whatever `GET /v1/requirements` lists; the reference fields are `aes_key`, `channel`,
>   and `heartbeat_period_duration`.
> - `registerMeters` takes a list of meters and posts `POST /v1/nodes/register` once per meter,
>   one after another. Each meter carries `node_id` in point 7's spelling, `node_type`, and any
>   optional register field the adopter sends, including `request_phased_readings`.
> - `unregisterMeters` takes a list of meters and calls `DELETE /v1/nodes/{node_id}` once per
>   meter.
>
> Each operation returns sparknet-http's HTTP answer, per meter for the list operations. It does
> not wait for or track the outcome events (`driver_configuration_applied`, `node_registered`,
> `node_already_registered`, `node_unregistered`, `node_to_unregister_unknown`).
>
> This service stores no meter list and no init payload and never replays either. After an init,
> the adopter registers every meter on that basestation, then enqueues a full configure for each
> (point 4). A three-phase meter is registered with `request_phased_readings` true; its readings
> then arrive as `electrical_meter_reading_phased` and are forwarded as point 5 describes. The
> adopter handles what they contain.
>
> Each basestation's id and base URL live in the plugin settings, for example
> `settings.basestations: [{ id, baseUrl }]` (ADR-002 §1: non-secret topology). The id is the
> value the adopter sends as `device.relayNode.id`. Adding a basestation is a config change and a
> restart.
>
> When a basestation's event stream drops, the plugin reopens it with backoff. While it is down,
> the pick skips that basestation's queue. Commands already sent keep their stage deadlines.
>
> This service tells the adopter when a basestation needs init, through the existing
> `eventWebhook` URL. When that fires is point 8b.

The init values include `aes_key`, a network secret. It passes through this service in the
request body and is never stored. ADR-002's per-deployment environment secrets do not apply.

Follow-ups, not decided here:

- ~~The webhook body for "basestation needs init".~~ Settled by ADR-009 (2026-10-29): a second
  envelope variant with `relayNode: { id, status: 'INIT_REQUIRED' }` instead of `message`.
  Message events are unchanged.
- Provisioning calls run beside the queue, outside point 6's one-call-at-a-time send lock per
  basestation. Whether they take that lock is open.
- The init path. The spec and the emulator use `POST /v1/init`; the sparknet-http README
  documents `POST /v1/sparknet/init`.
- A synchronous `registerMeters` for a few hundred meters over a remote link is a long request.

### Point 8b — accepted wording

> This service asks the adopter to init a basestation only after `gateway_status` on that
> basestation's event stream goes from `connected` false to `connected` true. A disconnect pauses
> sparknet-http's processing and keeps the registered meters in memory. A reconnect does not resume
> processing. The adopter then calls `initBasestation`, then `registerMeters`, then enqueues a full
> configure for each meter (point 4). Init clears the retained meters and reapplies the network
> configuration.
>
> From the moment `connected` is false, the pick skips that basestation's queue. It stays skipped
> after `connected` returns to true, until `initBasestation` and the following `registerMeters` for
> that basestation have both been accepted. Configure enqueues then use the queue as usual.
> Commands already sent keep their stage deadlines.
>
> An SSE drop and reconnect, with no `connected` false-then-true on that stream, reopens the queue
> and does not ask for init. `/v1/healthz` and `/v1/status` cannot separate a process restart from
> a network interruption, and both look the same from the cloud as from the basestation. A restart
> during that gap is still invisible. SparkMeter's `query_provider_status` / `uptime_ms` idea stays
> out until they confirm it.

### Point 9 — accepted wording

This service runs in the cloud and is itself the HTTP client of sparknet-http. ThunderCloud's
cloud is not: the ground system dials out and syncs, and only the ground system calls the driver
(Established facts). How a basestation becomes reachable is the same class of problem as reaching
a CALIN DCU or gateway, and it is solved the same way, outside this service.

> How a basestation's sparknet-http becomes reachable from this service is outside this service.
> The operator provides a route to each `settings.basestations[].baseUrl`. The plugin is a plain
> HTTP client of that URL.
>
> sparknet-http has no client auth. The route is a private, encrypted network, and that network
> is the only access control in v1. It keeps `aes_key` off the open internet. The plugin sends no
> auth header. An authenticating proxy in front of sparknet-http, with a per-basestation header
> from environment secrets (ADR-002), is a later addition.
>
> This service is the only command client of that sparknet-http. A technician using
> SparkMAC-tools on site pauses scheduled activity; commands sent meanwhile end on their
> deadlines.

### Point 10 — accepted wording

Amended 2026-10-29 after question 7. `node_id` does not say which configure an `applied` event
belongs to. The six echoed fields do, except when two commands post the same six numbers.

Points 2 and 3 name the match events and keep the delivery statuses. They do not assign them.

> - `sendOne` returns when sparknet-http answers `202 Accepted`. The message moves to the
>   relay-node stage (`DELIVERED_TO_NS`). sparknet-http is the network server here.
> - `configuration_accepted` moves it to the device stage (`SENT_TO_DEVICE`).
> - `configuration_applied` ends it with `DELIVERY_SUCCESSFUL` when the six configuration
>   fields on the event match the body this command posted. A mismatch is left unmatched, and
>   the unmatched-event metric counts it. On and off at the same `power_limit` echo the same
>   six fields, so those two cannot be told apart. `current_limit` stays the model's inrush.
>   It is not a correlation id.
> - `invalid_electrical_meter_configuration` ends it with `DELIVERY_FAILED` and `skipRetry`.
> - In `parseError`, a 4xx answer to `sendOne` sets `skipRetry`. A 5xx, a timeout, or a network
>   error retries.
> - The plugin omits `getRemoteStatus`. The spec has no way to see what the driver still holds,
>   so the relay-node wait cannot be extended. It ends at `relayNodeInFlightTimeoutMs`.
> - The plugin matches the OpenAPI wire names: `electrical_meter_configuration_accepted`,
>   `electrical_meter_configuration_applied`, and `invalid_electrical_meter_configuration`.

What configure-meter does for a node that is not registered is not in the spec, the OpenAPI, or
the sparknet-http README (question 6). It does not change this mapping. Such a command ends on
its deadline until item 5 sees what the emulator does.

### Point 11 — accepted wording

Amended 2026-10-29 after question 7. The driver does not stop retrying a pending configuration,
so this deadline cannot be sized to outlast that loop.

The core defaults are a LoRaWAN scale: `deviceInFlightTimeoutMs` is 12 seconds and
`relayNodeInFlightTimeoutMs` is 15 minutes. The emulator emits `configuration_applied`
immediately, so a number measured there is not a mesh deadline. This plugin omits
`getRemoteStatus` (point 10), so the relay-node timer is a hard deadline rather than a wait
that can be extended.

> - `nsInFlightTimeoutMs` covers the HTTP call to sparknet-http, and is also the send-lock
>   expiry.
> - `relayNodeInFlightTimeoutMs` covers `202` to `electrical_meter_configuration_accepted`.
>   When it fires, the command fails or retries. A 5xx, an HTTP timeout, or a network error
>   on `sendOne` still retries. The meter hold from point 6 lasts the whole wait.
> - `deviceInFlightTimeoutMs` is how long this service waits from
>   `electrical_meter_configuration_accepted` to `electrical_meter_configuration_applied`.
>   sparknet-http retries that pending configuration on its own, up to three times per
>   heartbeat period, and keeps going in later periods with no time limit and no exhaustion
>   event. The first try can go out immediately. Expiry ends the command with
>   `DELIVERY_FAILED` and does not post configure again. The failure reason says confirmation
>   was not seen and the driver may still be delivering. A later `applied` is handled by
>   point 10. The meter hold lasts until the command is terminal.
> - The heartbeat period is an init value the adopter sends. This service does not keep it, so
>   the deadlines are static plugin tuning, overridable per deployment in `plugins[].tuning`
>   (ADR-002 §5). The plugin passes its own deltas and does not inherit the core defaults as
>   mesh values.
> - Values used against the emulator are development values. The production device wait is
>   chosen at the real-basestation trial, long enough that a reachable meter usually confirms.
>   The guide says how to size the deployment override.

ADR-008 sends every device-stage timeout through `retryOrFail`. This plugin needs that timeout
to be terminal. ChirpStack keeps the retry. Checklist item 4 amends ADR-008. Item 5 implements
it.

---

## Questions for SparkMeter

*Reader: maintainer. Sent by a human, in their own words. An AI agent only records the answers.*

Only what the repos cannot answer. Questions 1 and 2 sent 2026-10-26 and answered 2026-10-28.
Question 3 sent 2026-10-27 and answered the same day. Question 4 sent 2026-10-28; a partial
answer arrived 2026-10-29, with heartbeat statistics and `uptime_ms` still to be verified by
SparkMeter. Question 5 answered 2026-10-29. Question 6 is for the emulator, not SparkMeter.
Question 7 answered 2026-10-29. It does not block the build. The production device wait is
chosen at the real-basestation trial.

1. When sparknet-http restarts, does it forget the registered meters and their configuration, so
   we must call init, register, and configure again every time?
   **Answered 2026-10-28: yes.** When sparknet-http restarts, it needs to be initialized, and the
   meters must be registered and configured again. ThunderCloud detects the restart and handles
   this automatically.
2. If our connection to `/v1/events` drops for a while, are the events from that gap lost for
   good, or is there a way to get them back?
   **Answered 2026-10-28: lost.** Events missed during a connection gap are lost. sparknet-http
   has no persistent event history or replay mechanism. SSE event ids alone do not provide
   replay. gRPC behaves the same way, so it offers no advantage for recovering missed events.
3. Does a configure request accept a field, debug or otherwise, that the driver copies onto the
   matching events? Spec v1.4 has none. The emulator drops unknown keys. The sparknet-http
   service source is not in the repos we can read. If such a field exists, correlation can use
   it instead of one command per `node_id`.
   **Answered 2026-10-27: no.** SparkMeter described two paths, neither with a job id.
   Heartbeat reads are produced inside sparknet-http, time-aligned to the heartbeat; the client
   just reads the stream. They also said a config request is retried automatically on its way
   through sparknet-http, and that a state machine above the driver then compares each later
   reading to the desired config and sends another update on drift. That upper layer treats
   meter config as eventual consistency with a digital twin, not as a correlated event queue.
   The published sparknet-http README names `SPARKNET_HTTP_READING_RETRY_LIMIT` only. It does
   not document config-packet retries, and the service source is not published. Question 7,
   answered 2026-10-29, confirms the configure retries and states the limits.
4. Our client runs in the cloud and reaches sparknet-http over a network link, not on the same
   box. When `GET /v1/events` drops and we reconnect, how can we tell whether sparknet-http
   restarted (and needs init, register, and configure) or only the connection dropped? Does
   `/v1/status`, `/v1/healthz`, or an event show init state, process uptime, or a boot id?
   Before init, does it emit `heartbeat_statistics`, and is `total_registered_nodes` 0 after a
   restart? When `gateway_status` goes `connected` false and back to true, has the driver lost
   its meters or only the gateway link? Does an init on a driver that did not restart do harm
   beyond clearing the registered meters?
   *Sent by the maintainer in their own words; this is the draft from chat.* Background:
   ThunderCloud's metering lifespan is a no-op in the cloud
   (`thundercloud/sparkmeter/metering/lifespan.py` lines 310–317). It only ran on the same box
   as the driver, where it treats any stream drop as a restart (lines 330–368).
   **Answered 2026-10-29, in part.** SparkMeter had not looked at startup and heartbeat-statistics
   behavior for a while and will set up a test to verify it. On the other points: an SSE
   disconnect and reconnect cannot distinguish a process restart from a temporary network
   interruption. `/v1/healthz` confirms the HTTP service is responding. `/v1/status` reports
   gateway information. Neither provides an initialized flag or a unique startup id. The
   `query_provider_status` command, sent through `POST /v1/commands`, returns an SSE event
   containing `uptime_ms`, which could identify a restart by comparing samples. SparkMeter still
   needs to verify that command and its uptime reporting. Disconnecting the gateway pauses
   processing but retains the registered meters in memory. Reconnecting it does not resume
   processing; the application must call init, then register and configure the meters again.
   Calling init when sparknet-http did not restart clears the registered meters and reapplies the
   network configuration; the application must then register and configure the meters again. The
   interface behavior is the same whether the client runs in the cloud or on the same box as
   sparknet-http. `query_provider_status` and `uptime_ms` are not in meter-driver-spec v1.4 or
   the published sparknet-http README. The guide already leaves `POST /v1/commands` off the
   emulator, which does not implement it.
5. Do the meters keep an internal clock, and does the application have to set it? Are the meters
   used in STS mode?
   **Answered 2026-10-29.** Time synchronization happens behind the scenes. sparknet-http includes
   the current time and heartbeat timing in outgoing SparkNet protocol packets, and the meter
   firmware uses those timestamps to synchronize its internal clock. The application does not need
   to set the meter's time separately. SparkMeter does not use or support meters in STS mode.
6. What does sparknet-http answer, and which event does it emit, for a configure-meter on a
   `node_id` that is not registered? The spec names an unknown-node event only for unregister.
   *Not for SparkMeter.* The spec, the OpenAPI, and the sparknet-http README do not say. Item 5
   records what the emulator does. The event names are settled: the OpenAPI constants are the
   wire names (see Established facts).
7. When we configure a meter, sparknet-http emits an "accepted" event and later an "applied"
   one. If the meter does not apply the change straight away, does sparknet-http keep trying on
   its own? How many times, or for how long, before it stops? We need that so we don't send the
   same configuration again while sparknet-http is still working on the first one.
   Roughly how long does accepted-to-applied usually take? Does it wait for the meter's next
   heartbeat, and does it take longer when the meter is more hops away? Sites use different
   heartbeat periods, so the retry limit is the figure we actually need.
   **Answered 2026-10-29.** Once sparknet-http has accepted a meter configuration, it retries on
   its own. The application does not need to retry it immediately. It makes up to three attempts
   per meter per heartbeat period. If the configuration remains pending, it retries in later
   heartbeat periods. There is no overall time limit while it remains pending, and no event when
   retries are exhausted. A newly accepted configuration can be sent immediately. It does not
   have to wait for the next heartbeat. Accepted-to-applied time depends on the network, queued
   work, and hop count. An unreachable meter can stay pending across many periods. There is no
   guaranteed completion time. Invalid configuration is a separate report
   (`invalid_electrical_meter_configuration`). Submitting a new configuration replaces the one
   still pending. The next heartbeat reading shows that the meter is communicating and does not
   carry every setting, so it cannot confirm the configuration. A dropped event stream can miss
   `applied` even though the driver already has the confirmation. SparkMeter's advice: treat
   accepted as still pending and applied as the confirmation. If confirmation takes longer than
   an operational threshold, flag it as not confirmed rather than resending. Points 10 and 11
   record what this service does with that. Checked before the answer: not in meter-driver-spec,
   the sparknet-http README, ThunderCloud, or the public web. The only published retry knob is
   `--reading-retry-limit`, named for readings.

The gRPC package name (`tc2.` or not) can be checked without them, by running the real image and
listing its services with `grpcurl list`. It does not matter while gRPC is deferred.

---

## Session notes

*Reader: both. An AI agent appends a note when a point lands; the maintainer reviews it.*

**2026-10-26** — Plan created. Point 1 accepted, with reasoning backed by the spec, the proto, and
ThunderCloud's client. The deployment assumption (this service replaces ThunderCloud for a grid)
was confirmed by the maintainer. That assumption puts points 4 and 8 under pressure; both stay
open. SparkMeter questions sent; no answers yet.

**2026-10-27** — Point 2 accepted. The plugin stays PUSH and holds `GET /v1/events`. The engine
calls optional `start` once from the composition root; the plugin parses and calls `deliver`.
`dropped` is recorded and left inert. Reconnect and recovery stay in points 4 and 8. Delivery
statuses are unchanged. The maintainer requires `electrical_meter_reading` to be emitted as an
unsolicited event; that is parked on point 5, where "reads stay out" means no enqueued `READ_*`.

**2026-10-27** — Point 3 accepted. One command per `node_id` until it is terminal, including
retry. The delivery id is `{pluginId}:{nodeId}` on the existing index. Readings do not use it.
Point 6 must enforce the per-meter half. Question 3 was answered the same day: no echoed field.
The one-command-per-`node_id` rule stands.

**2026-10-27** — `SET_BALANCE` deferred. v1 commands for this plugin are `TURN_ON`, `TURN_OFF`,
and `SET_POWER_LIMIT`. A payment updates the caller's wallet. This service hears about it only
when the caller changes the relay or the limits. The balance-cache write (spec §5.8) is
described under **Deferred — `SET_BALANCE`**, including what the command would post and when
to reopen it. Point 5 is not accepted: the unsolicited reading's command type is still open.

**2026-10-27** — Deployment scope narrowed by the maintainer. Legacy sites only, and only a single
basestation per site: one sparknet-http, one event stream. A second basestation on the same site
is out of scope.

**2026-10-27** — Point 4 accepted. Every configure enqueue carries the spec command name and all
six configuration fields. A missing field fails enqueue. This service does not default, merge, or
store a desired configuration. The in-flight message holds the body until the command is
terminal, and a retry posts that same body. `node_id` stays the device address (point 7). A node
roster and an init payload stay in point 8. The public `commandType` check is point 5. Widening
`requestData.payload` is implementation work, not a stored meter config.

**2026-10-27** — Point 5 accepted. Enqueue accepts `TURN_ON`, `TURN_OFF`, and
`SET_POWER_LIMIT`, and `validateEnqueue` requires the matching spec relay command.
`SET_POWER_LIMIT` may carry enable or disable, because the spec has no power-limit command.
`READ_REPORT` carries `electrical_meter_reading` and `electrical_meter_reading_phased` with
the spec fields except `node_id`, and it does not touch an in-flight command. The command
set does not grow. `request_phased_readings` stays in point 8.

**2026-10-28** — Maintainer. This plugin replaces ThunderCloud and as much of the other SparkMeter
software as we can. sparknet-http is the piece we expect to keep. ThunderCloud does not run
beside this service, and its reconcile is not the behavior to copy. The caller's model is
Tiamat meter-interactions: one read, write, setting, or token command. Recorded under
**Deployment assumption** and in **How to pick this up cold**.

**2026-10-28** — Point 6 accepted. One ready queue per basestation
(`queue:sparkmeter-sparknet-http:basestation:{basestationId}`, id from `device.relayNode.id`).
A pass picks every such queue. One HTTP call at a time per basestation, released when the
call settles. One command per meter until terminal, including retry, stored as a string
whose key is the meter and whose value is the owning message id. The pick reads that
meter's hold and must not scan the meters in use, or walk an unbounded run of held meters
on every pass. `spacing` and `concurrency` are unchanged for the other plugins.

**2026-10-28** — Point 7 accepted, then reopened the same day. The acceptance said
`external_reference` holds ThunderCloud `meter.code`. The maintainer asked whether a long
meter number is the serial instead, which would make storing `code` in that column wrong.
`47001763227` is a CALIN id. SparkMeter serials are `{model}-{version}-{8 hex digits}`.
`code` is the low 16 bits of that hex, and that is the `node_id` the driver is called with.

**2026-10-28** — Point 7 accepted. The maintainer rejected a serial-to-code map in this
service. Skyfox keeps the printed serial, derives `code`, and sends that code as
`device.externalReference`. Events copy `node_id` back as those same decimal digits.
Skyfox matches the code to the meter. This service does not parse serials. Today's
Tiamat client copies `meters.external_reference` straight onto the wire, so Skyfox has
to send the code for this manufacturer rather than the serial.

**2026-10-28** — SparkMeter answered questions 1 and 2. A restarted sparknet-http must be
initialized, and its meters registered and configured again; ThunderCloud detects the restart
and does this automatically. Events missed during a connection gap are lost: no persistent
history, no replay, SSE event ids do not help, and gRPC is the same. Point 1's reopen rule
(gRPC resumes or replays and SSE cannot) is not met, so point 1 stands. Question 3's answer is
unchanged. Point 8's assumption that the driver already knows the meter does not hold after a
restart.

**2026-10-28** — Maintainer. The platform above this service, which holds the meters per grid
and basestation, calls init and register, and it does so through this service. This service
tells that platform when a basestation needs init, over the same webhook it uses for message
events. When a basestation needs init is asked of SparkMeter as question 4, sent the same day.

**2026-10-28** — Point 8 split. 8a accepted: the adopter owns each basestation's session through
the provisioning operations `initBasestation`, `registerMeters`, and `unregisterMeters`, which
forward to sparknet-http. This service stores no meter list and no init payload. Basestation ids
and base URLs live in the plugin settings. The plugin reopens a dropped stream with backoff and
skips that basestation's queue while it is down; points 2 and 6 carry a one-line note. Three-phase
meters are registered with `request_phased_readings` true by the adopter, which handles the phased
readings. This service tells the adopter on the existing webhook URL when a basestation needs
init. 8b, when that is, waits on question 4. The plan names no adopter in 8a and avoids "driver"
for our own vocabulary.

**2026-10-29** — SparkMeter answered question 5. The meter has an internal clock. sparknet-http
puts the current time and the heartbeat timing in outgoing SparkNet packets, and the firmware
synchronizes from those. This service does not set the time. SparkMeter does not use or support
meters in STS mode, so `EnableSts` stays rejected and the STS token commands stay out.

**2026-10-29** — SparkMeter answered question 4 in part. An SSE reconnect cannot separate a
process restart from a network interruption. `/v1/healthz` and `/v1/status` have no initialized
flag and no startup id. `query_provider_status` on `POST /v1/commands` may return `uptime_ms`
on the event stream; SparkMeter has not verified that command, nor heartbeat statistics after
startup. A gateway disconnect pauses processing and keeps the meters in memory. A gateway
reconnect does not resume processing: the client must init, then register and configure again.
Init on a process that did not restart clears the meters and reapplies the network
configuration, and the meters must be registered and configured again. Cloud and on-box clients
see the same interface. The earlier heartbeat hypothesis (nodes above 0 means skip init) does
not cover the gateway case, where meters can still be registered while processing stays paused.

**2026-10-29** — Point 8b accepted. This service asks the adopter to init only after
`gateway_status.connected` goes from false to true. The queue stays skipped from that false until
`initBasestation` and the following `registerMeters` have both been accepted. An SSE reconnect
alone reopens the queue and does not ask for init. A process restart during that gap stays
invisible until SparkMeter confirms `query_provider_status` / `uptime_ms`. Point 6 carries one
more skip condition. Design points are complete. Next checklist item is the ADR.

**2026-10-29** — Maintainer. This file stays in `docs/plans/` as both the design record and the
build plan; there is no separate plugin ADR. ADRs cover only the engine and contract changes,
each accepted before the item that implements it. The Checklist moved up and became ten items.
ADR-009 covers both the configure body and the "basestation needs init" webhook event up front.
Provisioning uses the existing `provisioning.execute` and needs no engine ADR. Every item starts
with a summary and a named model (Claude Opus 5.5 or Grok 4.7), and ends with a stay-or-hand-off
recommendation. Next is item 1.

**2026-10-29** — Gap review against the original design gaps. Added facts: the driver has no
client auth, the spec names the configure events two ways, it is silent on configure for an
unregistered meter, it has no way to inspect the driver's queue, and SparkMAC-tools mode pauses
scheduled activity. Added open design points 9 (reaching a basestation), 10 (stage mapping), and
11 (stage deadlines), each with a recommendation. Drafted questions 6 and 7. Checklist: emulator
in compose (item 2), unmatched-event metric and point 10 and 11 dependencies (item 4),
stream-connected gauge (item 7), and a new item 11, the real basestation trial.

**2026-10-29** — Point 9 accepted. The path that makes a basestation reachable stays outside this
service, the same class of problem as reaching a CALIN DCU. The plugin is a plain HTTP client of
`baseUrl`, and a private encrypted route is the only access control in v1. ThunderCloud's cloud
does not call sparknet-http: 1.x has the grid-edge unit dial the cloud over a custom TCP
protocol, and 2.0 syncs ground and cloud databases with SymmetricDS while only the ground webapp
calls the driver.

**2026-10-29** — Point 10 accepted. `202` moves the message to `DELIVERED_TO_NS`,
`electrical_meter_configuration_accepted` to `SENT_TO_DEVICE`, `_applied` ends it with
`DELIVERY_SUCCESSFUL`, and `invalid_electrical_meter_configuration` ends it with
`DELIVERY_FAILED` and no retry. A 4xx answer to `sendOne` does not retry; a 5xx, a timeout, or
a network error does. The plugin omits `getRemoteStatus` and matches the OpenAPI wire names.
A configure for an unregistered node is not in the spec; that command ends on its deadline
until item 4 records what the emulator does. Point 11 is the remaining open design point.

**2026-10-29** — Point 11 accepted. `nsInFlightTimeoutMs` covers the HTTP call and the send
lock, `relayNodeInFlightTimeoutMs` covers `202` to `accepted`, and `deviceInFlightTimeoutMs`
covers `accepted` to `applied`. The relay timer is a hard deadline because `getRemoteStatus`
is omitted. Deadlines are static plugin tuning with a per-deployment override. The plugin does
not inherit the core 12-second and 15-minute defaults as mesh values, and emulator timings are
development values only. A production device deadline has to outlast the driver's own configure
retries. Question 7 asks for that budget and should be sent; it does not block the build. All
design points are accepted. Next checklist item is 1, ADR-009.

**2026-10-29** — Maintainer sent question 7 to SparkMeter. No answer yet. It does not block the build.

**2026-10-29** — Checklist item 1 landed: ADR-009
(`docs/architecture/009-configure-payload-and-relay-node-init-event.md`), indexed in `AGENTS.md`,
and ADR-003 carries an amendment line. Docs only; no code. The maintainer settled three wire
questions. First, configure keys are camelCase on our wire and the plugin maps them to the spec's
snake_case; readings in `response.data` keep the spec names (point 5), an accepted asymmetry.
Point 4 has a note with the camelCase shape; its accepted wording is unchanged. Second, the
"needs init" event is a second webhook envelope variant with no `message`, told apart by key, so
message events stay byte-for-byte the same. Third, its block is `relayNode: { id, status }` with
`status` a closed enum, `INIT_REQUIRED` today. The wire keeps `relayNode`, not `basestation`; this
plugin uses "basestation" as its local noun (`relayNodeNoun: 'basestation'`). Renaming `relayNode`
contract-wide would be its own ADR-003 amendment. How the plugin hands that event to the engine is
left to item 3 (ADR-010) or item 9. Point 8a's webhook follow-up is struck. Question 7 is still
unanswered and does not block.

**2026-10-29** — ADR-009 decision 1 amended the same day, before item 2. The whole spec
configure body is not on our wire. The caller sends the command's argument on `payload` and the
state it must keep on `deviceState`: `powerLimit` for `TURN_ON` and `TURN_OFF`, and `relay`
(`ON` or `OFF`) plus `{ powerLimit }` for `SET_POWER_LIMIT`. `{ powerLimit }` is one schema,
shared with `POST /token/generate`. The plugin derives `Enable` or `Disable` and fills
`currentLimit` (default 200 A), `startupDelay`, and the three throttle fields from
`settings.meterConfiguration`. Those four are required and have no default. This service stores
no desired configuration. Decision 2, the relay-node event, is unchanged. Points 4 and 5 are
rewritten to match. The checklist rows for items 1 and 2 name the lean shape.

**2026-10-29** — SparkMeter answered question 7. After `electrical_meter_configuration_accepted`,
sparknet-http retries the pending configuration itself: up to three attempts per heartbeat
period, then again in later periods, with no time limit and no exhaustion event. The first
attempt can go immediately. A new configure replaces the pending one. A reading cannot confirm
the configuration. Invalid stays a separate event. Points 3, 4, 10, and 11 are amended.
`deviceInFlightTimeoutMs` is a long operational wait. When it fires, the command ends
`DELIVERY_FAILED` and this service does not post that configure again. The failure reason says
confirmation was not seen and the driver may still be delivering. `applied` completes the
waiting command only when the six echoed fields match the posted body. A mismatch is unmatched.
On and off at the same power limit still look the same. `current_limit` stays the model inrush
and is not a correlation id. Retries before the accepted event are unchanged. Checklist: a new
item 4 amends ADR-008 so this plugin's device timeout is terminal while ChirpStack still
retries. Later rows shifted by one. Older notes cite the numbers from before that insert. The
event stream is item 5 and implements the six-field check and that terminal timeout. Init
gating is item 10. The guide's sizing note stays on the smokes-and-docs item. The production
number is chosen at the real-basestation trial.
