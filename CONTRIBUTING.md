# Contributing

[← README](README.md)

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

[Open an issue](https://github.com/alexma01/sniffo/issues) with your OS, Sniffo version, what you did, what you expected and what happened. A HAR export (*File → Save session…*, or right-click a flow → *Export as HAR…*) helps; remove secrets first.

## Sending a change

1. Set up the project: [Development](docs/development.md).
2. Branch from `develop`: `feature/<name>` (or `hotfix/<x.y.z>` from `main` for urgent fixes).
3. Keep the change small and in the style of the code around it. No new dependency for what a few lines can do.
4. Add or update tests. A new or renamed IPC command needs `src/api.ts`, `src/dev-mock.ts` and `src-tauri/tests/commands.rs` updated, or `cargo test -p sniffo` fails.
5. UI change? Check it in `pnpm dev` → `/?gallery`, dark and light.
6. Run `pnpm test` and `pnpm build`.
7. Open a pull request against `develop`.

## Branches

Git-flow:

| Branch | Purpose |
|---|---|
| `main` | Released versions only, tagged `vX.Y.Z` |
| `develop` | Integration branch; features merge here |
| `feature/<name>` | New work, from `develop`, merged back with `--no-ff` |
| `release/<x.y.z>` | Stabilisation before a release; merged into `main` (tagged) and back into `develop` |
| `hotfix/<x.y.z>` | Urgent fixes from `main`; merged into `main` and `develop` |

## Commits

[Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `docs:`, `chore:`, `test:` … Subject in the imperative, under ~70 characters; body explains why.

## AI coding agents

Agents start from [AGENTS.md](AGENTS.md) (`CLAUDE.md` is a symlink to it).
