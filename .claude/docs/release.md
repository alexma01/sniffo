# CI and releases

- CI (`.github/workflows/ci.yml`): on push to `develop`, `main`, `feature/**`, `release/**`, `hotfix/**` and every PR. macOS, Linux, Windows: `pnpm build`, `pnpm test:ui`, `cargo test -p sniffo-core`, `cargo test -p sniffo`.
- Release (`.github/workflows/release.yml`): push tag `vX.Y.Z` from `main` → unsigned bundles (dmg arm64/x64, msi/exe, AppImage/deb) on a draft GitHub release. Signing needs Apple/Tauri secrets.
- Git-flow: `release/<x.y.z>` and `hotfix/<x.y.z>` merge into `main` (tagged) and back into `develop`.
