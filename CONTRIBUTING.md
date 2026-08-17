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

## License

By opening a pull request you agree that your contribution is licensed under
[MPL-2.0](LICENSE), the same license as this project.
