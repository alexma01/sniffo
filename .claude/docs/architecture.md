# Architecture

```
React UI (src/) ──invoke()/listen()──▶ Tauri commands (src-tauri/src/lib.rs) ──▶ sniffo-core (crates/sniffo-core)
```

- **sniffo-core**: MITM proxy on hudsucker. `proxy.rs` handles flows, `flow.rs` the flow model, `rules.rs` breakpoints / Map Local / Map Remote / Block / throttle, `script.rs` JS rules on QuickJS, `ca.rs` root CA, `system.rs` OS proxy set/restore, `devices.rs` iOS Simulator + Android (adb), `net.rs` upstream proxy + DNS overrides, `har.rs` import/export, `compose.rs` Repeat/Compose, `client.rs` client-app detection.
- **src-tauri**: thin layer. Commands registered in `generate_handler!` in `lib.rs`. Flows are pushed to the UI as batched `flows` events; on broadcast lag it emits `flows:resync`.
- **src/api.ts**: typed wrappers over every command and event. UI code calls these, never `invoke` directly.

## UI run modes (src/main.tsx)

| Mode | How | Backend |
|---|---|---|
| Tauri app | `pnpm tauri dev` | real |
| Browser + mocks | `pnpm dev` → http://localhost:1420 | `src/dev-mock.ts` (fake data) |
| Browser + bridge | `?bridge=http://127.0.0.1:<port>` | `src-tauri/examples/ui_bridge.rs`: real app over HTTP, fake OS tools (e2e tests) |
| Gallery | `?gallery` (dev only) | every screen, dark + light |

Mocks and bridge are dev-only and never bundled.

## Adding an IPC command

1. Implement in `sniffo-core`, expose in `src-tauri/src/lib.rs` (`generate_handler!`).
2. Wrapper in `src/api.ts`.
3. Mock answer in `src/dev-mock.ts`.
4. Test in `src-tauri/tests/commands.rs`: it fails if api.ts, the app and the tests disagree on the command set.
