# Sniffo — agent guide

Free cross-platform HTTP/HTTPS debugging proxy. Tauri 2 desktop app: Rust proxy core + React UI. Product overview: [README.md](README.md).

`CLAUDE.md` is a symlink to this file: one file, two names. Editing either changes both. Never replace the symlink with a copy.

## Mandatory rules

1. **tokensave first.** The repo is indexed (`.tokensave/`). Explore code with the tokensave MCP tools (`tokensave_context`, `tokensave_search`, `tokensave_callers`, `tokensave_impact`, `tokensave_read`) before any grep/find/full-file read. No exploration sub-agents. Index stale or tools missing → say so, then fall back.
2. **caveman style.** Every reply terse: no filler, no pleasantries, no hedging, fragments OK, technical terms exact. Normal prose only for code, commits, PRs, security warnings, destructive-action confirmations. Claude Code: `caveman` plugin. Other agents: follow the same rules by hand.

## Map

| Path | What |
|---|---|
| `docs/`, `CONTRIBUTING.md` | Human docs: getting started, features, development (tests, CI, releases) |
| `crates/sniffo-core/` | Proxy engine (hudsucker): `proxy.rs`, `rules.rs`, `script.rs` (QuickJS), `ca.rs`, `system.rs` (OS proxy), `devices.rs`, `har.rs` |
| `src-tauri/src/lib.rs` | Tauri commands (IPC) — the only bridge UI ↔ core |
| `src/` | React UI. `api.ts` = typed IPC wrappers, `App.tsx` = shell |
| `tests-ui/`, `tests-e2e/` | UI unit tests, Playwright against the real app |
| `design/canvas/` | Committed design reference |

## Commands

Toolchain via mise (`mise install`, then `pnpm install`).

```bash
pnpm tauri dev                   # full app
pnpm dev                         # UI only, mocked data, http://localhost:1420
pnpm build                       # tsc + vite build
pnpm test                        # UI unit + core + IPC command tests (same as CI)
pnpm test:e2e                    # Playwright, on demand only
```

## Conventions

- Git-flow: work on `feature/<name>` from `develop`; `main` = releases only. Conventional Commits.
- Match surrounding code: small, few comments, no new deps for what a few lines do.
- New/changed Tauri command → update `src/api.ts`, `src/dev-mock.ts` and `src-tauri/tests/commands.rs`.

## Read when needed

- Architecture, IPC flow, mock/bridge modes → [.claude/docs/architecture.md](.claude/docs/architecture.md)
- Tests, CI, releases → [docs/development.md](docs/development.md). Ports: :9090 is often taken by another proxy; run Sniffo dev on :9191
- UI changes, theme, gallery, design canvas → [.claude/docs/ui.md](.claude/docs/ui.md)
- README screenshots: `docs/images/`, taken from the dev-mock UI. Public or example.com hosts only, no real names
