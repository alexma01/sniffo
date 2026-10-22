# Testing

| Suite | Command | Covers |
|---|---|---|
| UI unit | `pnpm test:ui` | `tests-ui/*.test.ts` (snippets, protobuf), plain node |
| Core | `cargo test -p sniffo-core` | proxy, rules, websocket, network, stress (`crates/sniffo-core/tests/`) |
| IPC | `cargo test -p sniffo` | every command the UI calls, on Tauri mock runtime, fake OS tools (`src-tauri/tests/`) |
| All of the above | `pnpm test` | same as CI |
| E2E | `pnpm test:e2e` | Playwright (Chromium + WebKit) vs the real app through `ui_bridge`. On demand, not in CI. Linux/macOS only |

- E2E builds `ui_bridge` in global setup, serves vite on :1430. Reports in `target/playwright-report`.
- OS tools are always faked in tests: nothing on the machine changes.
- Ports: :9090 is often taken by another proxy; run Sniffo dev on :9191.
