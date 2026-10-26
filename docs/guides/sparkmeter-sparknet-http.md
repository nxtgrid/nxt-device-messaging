# SparkMeter lab

Stand-in for the `sparkmeter-sparknet-http` plugin, which is not built yet.
The plugin will talk to a real [sparknet-http](https://github.com/EarthSpark/sparknet-http) process.
This lab runs [meter-driver-emulator](https://github.com/EarthSpark/meter-driver-emulator) instead: the same public HTTP and Server-Sent Events contract, with no gateway and no GroundBolt or ThunderCloud stack.

The contract is [meter-driver-spec](https://github.com/EarthSpark/meter-driver-spec) v1.4 (`docs/spec/index.md`, `openapi/meter-driver.yaml`).
Checked against emulator `0.1.0` (`ghcr.io/earthspark/meter-driver-emulator:main`).

## Run the emulator

Docker is the only dependency.

```sh
docker run --rm --name meter-driver-emulator \
  -p 18080:18080 \
  ghcr.io/earthspark/meter-driver-emulator:main
```

It logs `listening on http://0.0.0.0:18080`. Stop it with Ctrl-C, or `docker stop meter-driver-emulator`.

```sh
curl -s http://127.0.0.1:18080/v1/healthz
curl -s http://127.0.0.1:18080/v1/requirements
```

Health is `{"ok": true}`. This image requires `heartbeat_period_duration` and `aes_key` on init.
`GET /openapi.json` lists one `http` interface and no gRPC target.

Open the event stream before sending commands. The emulator does not replay missed events.

```sh
curl -N http://127.0.0.1:18080/v1/events
```

Init clears every meter and starts the heartbeat. Readings begin one period later. A period of `0` disables them.

```sh
curl -s -X POST http://127.0.0.1:18080/v1/init \
  -H 'content-type: application/json' \
  -d '{"heartbeat_period_duration": 15, "aes_key": "00112233445566778899aabbccddeeff"}'
```

Expect `driver_configuration_applied` and `gateway_status`.

```sh
curl -s -X POST http://127.0.0.1:18080/v1/nodes/register \
  -H 'content-type: application/json' \
  -d '{"node_id": 1001, "node_type": "SM5R"}'
```

Expect `node_registered`, then `node_firmware_version_changed`.
Any `node_id` is accepted. A registered meter then emits `electrical_meter_reading` every heartbeat (nominal 230 V, 50 Hz, 100 W until configured otherwise).

Configure sends the whole configuration object. The spec requires every field below.

```sh
curl -s -X POST http://127.0.0.1:18080/v1/meters/configure \
  -H 'content-type: application/json' \
  -d '{
    "node_id": 1001,
    "command": "ElectricalMeterCommandDisable",
    "configuration": {
      "power_limit": 1000,
      "current_limit": 10,
      "startup_delay": 0,
      "throttle_on_time": 5,
      "throttle_off_time": 10,
      "throttle_count_limit": 5
    }
  }'
```

The stream emits `electrical_meter_configuration_accepted`, then `electrical_meter_configuration_applied`, on that request.
Later readings for a disabled meter report zero power. Voltage stays nominal.
`GET /v1/status` stays `connected: true` and `gateway_type: "emulator"`.

`nxt-device-messaging` is not part of this process. Run it separately and point the plugin at `http://127.0.0.1:18080`.

## What a real sparknet-http changes

Register, configure, balance, and `GET /v1/events` are the shared surface. The switch for those calls is the base URL.

Confirm init against the driver's own `GET /openapi.json`. The spec and this emulator publish `POST /v1/init`. The sparknet-http README documents `POST /v1/sparknet/init`. Read `GET /v1/requirements` for the body. A real driver can require `channel` as well as the two fields this emulator asks for.

Leave these off the shared client. The emulator does not implement them, so a test run cannot stand in:

- gRPC (`--grpc-bind` on sparknet-http; this emulator advertises HTTP only)
- `POST /v1/commands` and the `SparkNetHttpControl` service

Behavior the emulator will not show: `configuration_applied` waits on the mesh instead of returning immediately, and `gateway_status.connected` can be false. A dropped event stream loses events on both sides. The emulator says so explicitly (`Last-Event-ID` is ignored).
