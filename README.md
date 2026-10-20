# Sniffo

A free, cross-platform HTTP/HTTPS debugging proxy (macOS, Windows, Linux). Every feature is included; nothing is behind a paid tier.

Built with [Tauri 2](https://tauri.app), a Rust proxy core (`crates/sniffo-core`, on top of [hudsucker](https://github.com/omjadas/hudsucker)) and a React UI.

## Features

- **Capture**: HTTP/1.1, HTTP/2 and HTTPS (MITM), with SSL proxying per host (include/exclude wildcards). Streaming responses (SSE, downloads) keep working while they're recorded.
- **Certificate**: a local root CA that one click installs and trusts on macOS, Windows or Linux (NSS included).
- **System proxy**: turned on and off in one click. The previous settings are saved and restored on exit, and after a crash.
- **Viewer**: virtualized list with configurable columns (client app, TLS, protocol, sizes, TTFB, duration). Filters by content type and status, regex, and full-text search in headers and bodies. Domain and app sidebar, pinning, and a status bar.
- **Detail**: headers, query, cookies, body (JSON tree, XML, form, multipart, images, hex), raw and timing.
- **Rules (unlimited)**: request/response breakpoints with editing, Map Local (inline or from a file), Map Remote, Block, an allow list, and throttling (latency and bandwidth presets).
- **Traffic tools**: Repeat, Edit & Repeat / Compose (with cURL import), copy as cURL / fetch / Python, request/response diff, HAR import/export, and sessions saved as HAR.
- **Protocols**: WebSocket frames, GraphQL operations, and Protobuf/gRPC decoding without a schema.
- **Scripting**: JavaScript `onRequest`/`onResponse` rules (QuickJS) with `sharedState` and a console.
- **Network**: upstream HTTP/SOCKS5 proxy, DNS overrides, reverse proxy, and an option to ignore upstream TLS errors (dev servers).
- **Devices**:
  - LAN mode with a QR code and a certificate page at `http://sniffo.cert`.
  - iOS Simulator: CA install, boot and restart.
  - Android emulators and USB devices: proxy via `adb reverse`, user or system CA, reboot.

## Development

Toolchain is pinned with [mise](https://mise.jdx.dev):

```bash
mise install
pnpm install
pnpm tauri dev
```

Core tests (no UI needed):

```bash
cargo test -p sniffo-core
```

Run `pnpm dev` and open http://localhost:1420 in a normal browser to work on the UI with mocked data (`src/dev-mock.ts`).

## Releases

Push a tag `vX.Y.Z` from `main`: the *Release* workflow builds unsigned bundles (macOS Apple Silicon and Intel `.dmg`, Windows `.msi`/`.exe`, Linux `.AppImage`/`.deb`) and attaches them to a draft GitHub release. Add Apple / Tauri signing secrets to the workflow to sign and notarize.

CI (`.github/workflows/ci.yml`) runs core and UI tests, plus the frontend build and an app compile check, on macOS, Linux and Windows for every push and PR.

## Branching

Git-flow:

| Branch | Purpose |
|---|---|
| `main` | Released versions only, tagged `vX.Y.Z` |
| `develop` | Integration branch; features merge here |
| `feature/<name>` | New work, branched from `develop`, merged back with `--no-ff` |
| `release/<x.y.z>` | Stabilisation before a release; merged into `main` (tagged) and back into `develop` |
| `hotfix/<x.y.z>` | Urgent fixes from `main`; merged into `main` and `develop` |

Commits follow [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `chore:` …).

## License

To be decided.
