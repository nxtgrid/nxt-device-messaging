# Plan 003 — `sparkmeter-sparknet-http` plugin

**Status:** design in progress — 2026-10-27. Points 1–3 accepted. Points 4–8 proposed, not accepted.
**Branch:** `plugin/sparkmeter-sparknet-http`. No code or ADR until the design points below are accepted.
**Supersedes nothing.**

This plan builds a delivery plugin that sends meter commands to a SparkMeter gateway through
[sparknet-http](https://github.com/EarthSpark/sparknet-http), the vendor's meter driver. The
driver implements [meter-driver-spec](https://github.com/EarthSpark/meter-driver-spec) v1.4.

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
  packaging only; the binary is closed source), and `thundercloud`, which contains SparkMeter's
  own client for this driver. Ask SparkMeter only what those cannot answer.
- Update the **Design points** table and **Session notes** when a point is accepted.

---

## Deployment assumption

*Reader: both. Set by the maintainer.*

This service **replaces** SparkMeter's current ThunderCloud setup for a grid. ThunderCloud and
this service do not drive the same sparknet-http at the same time. This service is therefore the
**only command client** of its driver, and inherits the jobs ThunderCloud did for it (see the
recovery facts below).

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
  (`thundercloud/sparkmeter/metering/reconcile.py` lines 1–17, 62–125.)
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
| 4 | The caller supplies the full configure object in `requestData`. This service keeps no meter state. | ☐ proposed — **under pressure, see below** |
| 5 | First commands: `TURN_ON`, `TURN_OFF`, `SET_POWER_LIMIT`. Reads and top-up stay out. | ☐ proposed — **unsolicited readings still go out, see below** |
| 6 | Admission is per gateway, and separately one in flight per meter. One queue key cannot express both. | ☐ proposed — **per-meter half required by point 3** |
| 7 | `externalReference` is the numeric `node_id`. | ☐ proposed |
| 8 | This service does not init or register in v1. The driver already knows the meter, and this process is the only command client. | ☐ proposed — **under pressure, see below** |

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

A configure that points 4 and 8 later re-send uses the same rule: the meter's current command
must be terminal before that id is minted again.

### Point 5 — unsolicited readings

`electrical_meter_reading` must reach the caller as an unsolicited event. "Reads stay out"
means no enqueued `READ_*` command. It does not mean dropping meter-pushed readings. The
engine already emits unsolicited events (ChirpStack `READ_REPORT`). Which command type and
payload carry this reading is decided with point 5, not before.

### Points 4 and 8 — must not be lost

Both rest on the driver remembering meters. It does not, across a restart. Because this service
replaces ThunderCloud, it inherits ThunderCloud's recovery job: after a driver restart or a dropped
stream, someone must re-run init, re-register every meter, and re-apply each meter's
configuration.

- **Point 8** assumes "the driver already knows the meter". That holds only until the next
  driver restart or stream drop. As the only command client, this service is also the natural
  owner of init.
- **Point 4** keeps no meter state. Then, after a restart, this service has nothing to re-send.
  Either it stores each meter's last applied configuration, or it tells the caller to re-send
  everything.

Neither point can be accepted as written without an answer to the recovery question. Point 2
is accepted: `dropped` is where a dropped stream is detected, and it does not itself reconnect
or recover.

SparkMeter's answer (question 3) puts the digital twin above this service. The caller, not this
service, holds desired state and enqueues a new command when a later reading disagrees. That
strengthens point 4: we store no meter config. It does not remove point 8's recovery question.
Questions 1 and 2 are still open. A driver that forgets its meters on restart still needs init
and register from whoever owns the twin. This service's part is to deliver one command, end it
on accepted, applied, invalid, or timeout, and forward readings (`state`, `user_power_limit`)
so the caller can see drift. We do not re-send because a reading drifted. Whether sparknet-http
itself retries a config packet after accept is not in the published docs (question 3).

---

## Questions for SparkMeter

*Reader: maintainer. Sent by a human, in their own words. An AI agent only records the answers.*

Only what the repos cannot answer. Questions 1 and 2 sent 2026-10-26, still awaiting answers.
Question 3 sent 2026-10-27 and answered the same day.

1. When sparknet-http restarts, does it forget the registered meters and their configuration, so
   we must call init, register, and configure again every time?
2. If our connection to `/v1/events` drops for a while, are the events from that gap lost for
   good, or is there a way to get them back?
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

The gRPC package name (`tc2.` or not) can be checked without them, by running the real image and
listing its services with `grpcurl list`. It does not matter while gRPC is deferred.

---

## Checklist

*Reader: both.*

Work items once the design is accepted. Kept coarse until then.

| # | Item | Depends on | Status |
|---|---|---|---|
| 1 | Resolve design points 4–8, one at a time | — | ☐ in progress (3 of 8 accepted) |
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
Point 6 must enforce the per-meter half. Question 3 (an echoed request field) was sent the same
day and stays open; a yes reopens the id scheme.
