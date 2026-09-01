# Deployment

This service is a container. The root [Dockerfile](../../Dockerfile) is what we run in production. Pin a GHCR tag (`ghcr.io/nxtgrid/nxt-device-messaging:vX.Y.Z`) or build from Git; both use that file.

**One replica** against a given Valkey/Redis ([ADR-007](../architecture/007-single-replica-deployment.md)). HTTP **3100**. Health: `GET /healthz`. Config and secrets: [README](../../README.md#configuration).

| Platform | Guide |
|---|---|
| DigitalOcean App Platform | [digital-ocean-app-platform.md](./digital-ocean-app-platform.md) |
