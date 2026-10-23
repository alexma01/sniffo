# Development

[← README](../README.md)

## Setup

Toolchain is pinned with [mise](https://mise.jdx.dev) (Rust stable, Node 22, pnpm 10).

```bash
mise install
pnpm install
pnpm tauri dev
```

Linux also needs the WebKitGTK libraries:

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev
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

The app renders in WebKit on macOS and Linux, and in Chromium (WebView2) on Windows: check both.

## Tests

| Command | What |
|---|---|
| `pnpm test` | Everything CI runs: UI unit, core and IPC command tests |
| `pnpm test:ui` | UI unit tests (`tests-ui/`) |
| `cargo test -p sniffo-core` | Proxy core: proxy, rules, WebSocket, network, stress |
| `cargo test -p sniffo` | Every IPC command the UI calls, on Tauri's mock runtime |
| `pnpm test:e2e` | Playwright on Chromium and WebKit vs the real app. On demand only; Linux and macOS |

OS tools (keychain, `networksetup`, `adb`, `xcrun`) are faked in tests: nothing on your machine changes.

## CI and releases

- **CI** (`.github/workflows/ci.yml`) runs `pnpm build`, `pnpm test:ui`, `cargo test -p sniffo-core` and `cargo test -p sniffo` on Linux and Windows for every PR and push to `develop`/`main` (macOS is tested locally, to stay within the free Actions minutes).
- **Release**: push a tag `vX.Y.Z` from `main`. The *Release* workflow builds unsigned bundles (macOS Apple Silicon and Intel `.dmg`, Windows `.msi`/`.exe`, Linux `.AppImage`/`.deb`) and attaches them to a draft GitHub release. Add Apple / Tauri signing secrets to the workflow to sign and notarize.

Ready to send a change? See [Contributing](../CONTRIBUTING.md).
