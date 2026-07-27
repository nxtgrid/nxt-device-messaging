# nxt-device-messaging

**Reliable, prioritized, retrying command delivery to addressable field devices.**

Give it a command for a device; it takes responsibility for getting it there. The service
queues the command, dispatches it through whichever network server that device speaks to,
tracks it through each delivery stage, retries with exponential backoff when a stage fails,
and reports the final outcome back to you over a signed webhook.

Hardware integrations are plugins. Three ship in the box — LoRaWAN via ChirpStack, and the
CALIN V1 and V2 vendor HTTP APIs — covering both delivery patterns: *push*, where the
network server calls back, and *pull*, where the service polls for status. Adding a fourth
is a single file.

Redis (or Valkey) is the only infrastructure dependency. There is no relational database.

## What this is not

Not a notification, SMS, or chat system. A "message" here is a command or read request
addressed to a physical device — read a meter's voltage, deliver a credit token, set a
power limit.

## Status

**Under construction.** This service is being extracted from the `device-messages` module
of [nxt-backend](https://github.com/nxtgrid/nxt-backend) (see its ADR-010). The extraction
is in progress and nothing here is deployable yet. Architecture decisions and the build
plan will live in `docs/`.

## License

[MPL-2.0](./LICENSE)