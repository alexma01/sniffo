# Getting started

[← README](../README.md)

## Install

Download the bundle for your system from the [GitHub releases](https://github.com/alexma01/sniffo/releases):

| System | File |
|---|---|
| macOS (Apple Silicon / Intel) | `.dmg` |
| Windows | `.msi` or `.exe` |
| Linux | `.AppImage` or `.deb` |

Builds are not signed yet:

- **macOS**: if Gatekeeper blocks the app, right-click it → *Open*, or run `xattr -dr com.apple.quarantine /Applications/Sniffo.app`.
- **Windows**: on the SmartScreen prompt choose *More info* → *Run anyway*.

Prefer building from source? See [Development](development.md).

## Capture your first request

1. **Start Sniffo.** The proxy listens on `127.0.0.1:9191` and, by default, turns on the system proxy (your previous settings come back on quit, and after a crash).
2. **Trust the certificate.** Click *Certificate not trusted* in the toolbar: Sniffo creates a local root CA and installs it (macOS keychain, Windows store, Linux NSS). Needed only once.
3. **Browse.** Requests from your browser and apps appear in the list. Click one to see headers, body, cookies, raw and timing.
4. **Decrypt HTTPS per host.** HTTPS hosts start as `CONNECT` tunnels, so apps with their own trust store keep working. Click *Enable SSL Proxying* on a row (or the lock in the sidebar) to decrypt that host.

## Other devices

Open *Devices* in the toolbar.

- **Phone or tablet on Wi-Fi**: scan the QR code, set the device's Wi-Fi proxy to the address shown, then open `http://sniffo.cert` on it to install the certificate.
- **iOS Simulator**: *Install & trust CA* on the booted simulator; keep *System proxy* on.
- **Android emulator or USB device**: Sniffo sets the proxy through `adb reverse` and installs the CA as a user or system certificate.

## Next

- Everything Sniffo can do: [Features](features.md)
- Something wrong or missing? [Open an issue](https://github.com/alexma01/sniffo/issues) or see [Contributing](../CONTRIBUTING.md).
