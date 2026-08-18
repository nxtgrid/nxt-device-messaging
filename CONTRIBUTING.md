# Contributing

Small, reviewable changes. Say **why** in the PR, not only what moved.

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Local run: see the [README](README.md) quick start (Valkey + `pnpm dev`).

Pre-commit already lints staged `.ts` and typechecks. Don't skip hooks to land a green PR.

Opt-in Redis smoke (Valkey must be up): `pnpm test:integration`.

## Pull requests

- Branch off `main`. Prefixes that help: `feature/`, `fix/`, `docs/`.
- One concern per PR when you can. A wall of unrelated diffs is hard to review.
- CI (`.github/workflows/build.yml`) runs lint, test, and build on PRs to `main`.

## Plugins

Hardware adapters live **in this repo**, not as an external package.

The contract is `src/plugins/plugin.interface.ts`. Register a factory in
`src/plugins/catalog.ts`. `src/plugins/stub/` is the smallest working example.

Plugins are plain objects. Don't import `runtime` from `lib/` or from a plugin —
take config and secrets as arguments. Log with `logger` and a `module` field
(`src/log.ts`).

Admission and queue keys: [ADR-006](docs/architecture/006-bottleneck-and-admission.md).

## Secrets

Never commit decoder keys, vendor passwords, API tokens, or `.env`.
Use environment variables (see `.env.example`).

If you find a credential in the tree or in logs, don't open a public issue — tell a
maintainer.

## Releasing (maintainers)

Bump the project version **before** tagging, in a PR merged to `main`.

### 1. Bump the version

Change only `package.json` `"version"` to the new semver (e.g. `0.1.1`). Leave
dependency versions alone. Keep the git tag aligned with that value
(`0.1.1` → `v0.1.1`).

The Docker/GHCR tag comes from the git tag (`vX.Y.Z`), not from `package.json`.

### 2. Merge to `main`

Open a PR for the bump (and any other changes that belong in the release), get
approval, and merge. Wait for `.github/workflows/build.yml` on `main`.

### 3. Tag and push

On the release commit on `main` (after merge):

```bash
git checkout main
git pull
git tag vX.Y.Z
git push origin vX.Y.Z
```

Use a leading `v` and three numeric components (`v0.1.0`). That pattern
triggers `.github/workflows/release.yml`.

### 4. Verify the release

Confirm the release workflow succeeded and that these images exist:

```
ghcr.io/nxtgrid/nxt-device-messaging:vX.Y.Z
ghcr.io/nxtgrid/nxt-device-messaging:latest
```

Each tag is a multi-arch manifest (`linux/amd64` and `linux/arm64`). Confirm
both platforms:

```bash
docker buildx imagetools inspect ghcr.io/nxtgrid/nxt-device-messaging:vX.Y.Z
```

Prefer the version tag over `:latest`. Optionally create a GitHub Release for
the tag with notes for operators.

### Notes

- Do **not** retag or force-push an existing `v*` tag unless you are sure no
  one has pulled that image.
- If a tag was pushed before the `package.json` version was bumped, leave it
  and cut the next patch (`vX.Y.Z+1`) after fixing the version — or accept the
  mismatch for that one tag.

## License

By opening a pull request you agree that your contribution is licensed under
[MPL-2.0](LICENSE), the same license as this project.
