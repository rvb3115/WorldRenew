# Local 0.5.5-test.1 builds

This feature branch prepares local test artifacts only. No new GitHub release, update feed or automatic installation is published. The existing v0.5.4-test.1 release stays unchanged.

Distributions use the same packaged application code:

- Windows x64 installer: `WorldRenew-0.5.5-test.1-windows-x64-setup-local-test.exe`, a persistent per-user installation with shortcuts. See [installer policy and native test procedure](WINDOWS-INSTALLER.md).
- Windows x64 portable alternative: `WorldRenew-0.5.5-test.1-windows-x64-portable.exe`, which extracts its runtime temporarily on launch.
- Apple Silicon macOS: `WorldRenew-0.5.5-test.1-macos-arm64.app.zip`, containing the complete app bundle.

Windows packages are unsigned. The Mac bundle has a local ad-hoc seal, without Developer ID signing or notarization. Test with disposable copies. Neither packaging nor byte-preservation tests certify Minecraft gameplay, farms, portals or seamless terrain.

## Reproduce

Use Node 22.12+ (tested with 24.19.0) in a writable checkout. Dependencies are pinned. Packaged users need neither Node nor Java to run WorldRenew.

```sh
npm ci
node qa/run.mjs --full
npm run build:test:macos             # Run on an Apple Silicon Mac
npm run build:test:windows           # Portable Windows EXE and packaged app
npm run build:installer:windows      # Persistent Windows installer
npm run test:packaged                # Native target OS/architecture only
```

If the current Windows packaged app was already built, `node scripts/build-installer.mjs --prepackaged` checks its runtime files against current source before wrapping it. Electron downloads use locked checksums. Build tools never publish or discover signing credentials.

Artifacts, checksums and metadata are under `artifacts/macos-arm64/`, `artifacts/windows-x64/` and `artifacts/windows-installer/`. Unpacked apps are under `dist/`; neither directory is committed. Windows wrapper payloads are extracted without running them and compared per file against the packaged app.

The packaged smoke suite tests inspection/protection/export, 3D transfer, archive/include-skip-air placement, detailed terrain and the local template library. On Mac it extracts the actual ZIP and verifies architecture, executable modes and the ad-hoc seal first. Windows native testing additionally exercises the portable launcher. The installer has a separate disposable-machine install/upgrade/uninstall script; cross-building and payload checks do not establish Windows runtime or installer correctness.

`build-info.json` and SHA-256 sidecars describe the artifacts. `smoke-results.json` is written only when native packaged checks pass. Checksums provide integrity, not publisher identity. Tests use synthetic fixtures and isolated profiles, never user saves.

The repository has no active GitHub Actions workflow. A historical workflow is retained under `disabled-workflows/`; it is reference material, not evidence that native CI ran. Automatic updates remain unconfigured; test builds are transferred and installed manually.
