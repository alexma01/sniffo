# Development

[← README](../README.md)

## Setup

Toolchain is pinned with [mise](https://mise.jdx.dev) (Rust stable, Node 22, pnpm 10).

```bash
mise install
pnpm install
pnpm tauri dev
```

## Project layout

```
crates/sniffo-core/   Rust proxy engine (hudsucker): capture, rules, scripts, CA, system proxy, devices
src-tauri/            Tauri app: IPC commands in src/lib.rs, the only bridge UI ↔ core
src/                  React UI; src/api.ts wraps every command and event
tests-ui/             UI unit tests (plain node)
tests-e2e/            Playwright tests against the real app
design/canvas/        Design reference (Signal theme, every screen dark and light)
```

## Working on the UI

No Tauri needed: run `pnpm dev` and open http://localhost:1420. Data comes from `src/dev-mock.ts`.

- `?theme=light` or `?theme=dark` forces a theme.
- `?gallery` shows every screen in both themes. Add new dialogs to `SCREENS` in `src/Gallery.tsx`.

The app renders in WebKit on macOS.

## Tests

| Command | What |
|---|---|
| `pnpm test` | UI unit, core and IPC command tests (CI skips the UI ones for now) |
| `pnpm test:ui` | UI unit tests (`tests-ui/`) |
| `cargo test -p sniffo-core` | Proxy core: proxy, rules, WebSocket, network, stress |
| `cargo test -p sniffo` | Every IPC command the UI calls, on Tauri's mock runtime |
| `pnpm test:e2e` | Playwright on Chromium and WebKit vs the real app. On demand only |

OS tools (keychain, `networksetup`, `adb`, `xcrun`) are faked in tests: nothing on your machine changes.

## CI and releases

- **CI** (`.github/workflows/ci.yml`) runs `pnpm build`, `cargo test -p sniffo-core` and `cargo test -p sniffo` on macOS for every PR and push to `develop`/`main`. UI unit tests (`pnpm test:ui`) are not run in CI for now.
- **Release**: on `develop` run `pnpm release patch|minor|major` (or an explicit `X.Y.Z`): it bumps the version files, commits `chore: release X.Y.Z` and pushes. Open the `develop` → `main` PR; once merged, the *Release* workflow tags `vX.Y.Z` (skipped if that tag exists) and builds unsigned bundles (macOS Apple Silicon and Intel `.dmg`; Windows and Linux bundles are disabled until they can be tested) and attaches them to a draft GitHub release. Add Apple / Tauri signing secrets to the workflow to sign and notarize.

Ready to send a change? See [Contributing](../CONTRIBUTING.md).
