# Plan 003 — `sparkmeter-sparknet-http` plugin

**Status:** design in progress — 2026-10-28. Points 1–7 and 8a accepted. Point 8b waits on
SparkMeter question 4.
**Branch:** `plugin/sparkmeter-sparknet-http`. No code or ADR until the design points below are accepted.
**Supersedes nothing.**

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
3. Take **one** open design point. Recommend an answer, wait for the maintainer to accept it.
   Do not write code or an ADR for a point that is not accepted.

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
- Update the **Design points** table and **Session notes** when a point is accepted.

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
- `POST /v1/init` clears every meter. (Guide, "Init clears every meter".)
- When the event stream ends or breaks, ThunderCloud treats the driver as restarted and re-runs
  the full init and reconcile. (`thundercloud/sparkmeter/metering/lifespan.py` lines 330–380.)
- ThunderCloud does not match acknowledgement events to commands. It only logs
  `electrical_meter_configuration_accepted`, `_applied`, and
  `invalid_electrical_meter_configuration`. (`thundercloud/sparkmeter/metering/events.py`
  lines 57–86.) Per-command tracking is new ground for this plugin.

**Differences between the emulator and a real driver**

- Init path: the spec and emulator use `POST /v1/init`; the sparknet-http README documents
  `POST /v1/sparknet/init`. A real driver can require `channel` on init.
- On a real driver, `configuration_applied` waits on the mesh, and `gateway_status.connected`
  can be false. The emulator shows neither.

---

## Design points

*Reader: both. The maintainer accepts or rejects; an AI agent recommends and updates the table.*

Proposed by the maintainer on 2026-10-26. Resolve one at a time, in order unless a dependency says
otherwise.

| # | Point | Status |
|---|---|---|
| 1 | Transport: HTTP and SSE per meter-driver-spec. gRPC deferred. | ☑ accepted 2026-10-26 |
| 2 | The engine needs a seam for an event stream the plugin owns. `incoming.handle` is only fed by HTTP ingress today. | ☑ accepted 2026-10-27 |
| 3 | Correlation: one in-flight command per `node_id`. Next command only after the previous is terminal. | ☑ accepted 2026-10-27 |
| 4 | Caller supplies the full configure body in `requestData`. This service keeps no desired configuration. | ☑ accepted 2026-10-27 |
| 5 | First commands: `TURN_ON`, `TURN_OFF`, `SET_POWER_LIMIT`. No enqueued reads. Unsolicited readings are `READ_REPORT`. `SET_BALANCE` deferred, see below. | ☑ accepted 2026-10-27 |
| 6 | One ready queue per basestation. One HTTP call at a time, and one command per meter until it is terminal. | ☑ accepted 2026-10-28 |
| 7 | `externalReference` is the decimal digits of `node_id`. Skyfox derives that from the serial and matches it back. | ☑ accepted 2026-10-28 |
| 8a | The adopter owns each basestation's session through provisioning operations (`initBasestation`, `registerMeters`, `unregisterMeters`). This service keeps no meter list and no init payload, holds basestation URLs in plugin settings, reconnects the stream, and tells the adopter when a basestation needs init. | ☑ accepted 2026-10-28 |
| 8b | When a basestation needs init, and when its held queue opens again. | ☐ open — waits on question 4 |

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
> Point 6 enforces the one-in-flight rule. No new lookup and no new SPI method.

There is no `networkServerRef` in this repo, the spec, or ThunderCloud. The stream belongs to
one plugin instance, and the event carries `node_id` only, so the plugin id is the scope the
plugin can rebuild when a frame arrives. SparkMeter confirmed there is no echoed request
field (question 3, answered 2026-10-27). The one-command-per-`node_id` rule stands.

A configure the caller sends later, including one sent for recovery under point 8, uses the same
rule: the meter's current command must be terminal before that id is minted again.

### Point 4 — accepted wording

> Each configure enqueue carries the spec body: the `ElectricalMeterCommand` name plus all six
> configuration fields (`power_limit`, `current_limit`, `startup_delay`, `throttle_on_time`,
> `throttle_off_time`, `throttle_count_limit`). The plugin posts that body. A missing field fails
> enqueue. Zero is a real value. This service does not fill ThunderCloud's defaults, merge with an
> earlier command, or keep a desired configuration. The in-flight message holds the body until that
> command ends (accepted, applied, invalid, or timeout); a retry posts the same body. After the
> command is terminal, the body is gone with the message. A later reading that disagrees is the
> caller's reason to enqueue a new command. `node_id` is the device address (point 7) and is not a
> second copy inside this body. A node roster and an init payload, if any, stay in point 8. The
> spec command in the body is what we post. Which `commandType` values this plugin accepts, and any
> check that they match that command, is point 5.

`requestData` cannot carry this body today. The schema is strict, and `payload` is only a date or
a time. Implementation adds this object to that union. `SET_POWER_LIMIT`'s token payload
`{ powerLimit }` is not this body.

### Point 5 — accepted wording

> The plugin's `supportedCommandTypes` are `TURN_ON`, `TURN_OFF`, and `SET_POWER_LIMIT`.
> Any other enqueue command type fails the existing membership check. `READ_REPORT` is not
> enqueueable.
>
> `validateEnqueue` compares `commandType` to the spec command in the body. `TURN_ON`
> requires `ElectricalMeterCommandEnable`. `TURN_OFF` requires
> `ElectricalMeterCommandDisable`. `SET_POWER_LIMIT` requires either of those two.
> `ElectricalMeterCommandReboot`, `ElectricalMeterCommandCalibrateStart`,
> `ElectricalMeterCommandCalibrateFinish`, and `ElectricalMeterCommandEnableSts` fail
> enqueue. The spec has no power-limit command. `power_limit` is one of the six fields, so
> `SET_POWER_LIMIT` is the caller's label and the relay verb stays in the body. A `TURN_ON`
> still carries all six fields, including a power limit.
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
`state` 13, and the spec has no clear-tamper call.

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

Follow-ups for after 8b, not decided here:

- The webhook body for "basestation needs init". Today's envelope
  (`src/engine/webhook/event-schema.ts`) requires a `message` with `device` and
  `deliveryStatus`, so this event changes the public contract (ADR-003, `packages/contract`).
- Provisioning calls run beside the queue, outside point 6's one-call-at-a-time send lock per
  basestation. Whether they take that lock is open.
- The init path. The spec and the emulator use `POST /v1/init`; the sparknet-http README
  documents `POST /v1/sparknet/init`.
- A synchronous `registerMeters` for a few hundred meters over a remote link is a long request.

### Point 8b — open, waits on question 4

When does a basestation need init, and when does its held queue open again?

Known: a sparknet-http restart closes the TCP connection, so every restart shows as a dropped or
unopenable `GET /v1/events`. Not every drop is a restart; over a network link most are not.
Events from the gap are lost (question 2). An unneeded init clears every meter on that
basestation. ThunderCloud treats any drop as a restart and re-inits, and also re-inits after
`gateway_status.connected` returns to true (`lifespan.py` lines 330–368, 398–495). That suits a
client on the same box, not ours.

Working hypothesis until SparkMeter answers: after reconnecting, wait for the next
`heartbeat_statistics`. If `total_registered_nodes` is above 0, sparknet-http kept its meters and
the queue opens again without an init. If it is 0, or no heartbeat arrives within a bounded wait,
the basestation needs init. Unverified: whether sparknet-http emits heartbeats before init (its
README lists a `--heartbeat` default; the emulator starts the heartbeat only at init). A weaker
clue is `/v1/status` `messages_sent` and `messages_received` coming back lower than last seen.

---

## Questions for SparkMeter

*Reader: maintainer. Sent by a human, in their own words. An AI agent only records the answers.*

Only what the repos cannot answer. Questions 1 and 2 sent 2026-10-26 and answered 2026-10-28.
Question 3 sent 2026-10-27 and answered the same day. Question 4 sent 2026-10-28, awaiting an
answer.

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
   not document config-packet retries, and the service source is not published, so that part
   of the answer is not confirmed from the repos.
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

The gRPC package name (`tc2.` or not) can be checked without them, by running the real image and
listing its services with `grpcurl list`. It does not matter while gRPC is deferred.

---

## Checklist

*Reader: both.*

Work items once the design is accepted. Kept coarse until then.

| # | Item | Depends on | Status |
|---|---|---|---|
| 1 | Resolve design point 8b | SparkMeter question 4 | ☐ in progress (1–7 and 8a accepted) |
| 2 | ADR(s) for accepted points that change the engine or the SPI | 1 | ☐ |
| 3 | Implementation slices, defined after 1 and 2 | 2 | ☐ |

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
