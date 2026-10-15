# WorldRenew 0.5.3 experimental test builds

Standalone desktop tools for inspecting and preserving Minecraft Java Edition worlds. One shared application for Windows x64 and Apple Silicon macOS; no mod or separate Java/Node installation is required for packaged builds.

**Experimental, unsigned test builds. Use disposable world copies only. Minecraft game-load, multiplayer login, portal travel, farm functionality and terrain continuity are not certified. Native Windows runtime validation is pending.**

## Downloads and launch

Get the Windows portable EXE or Apple Silicon app ZIP from [the experimental prerelease](https://github.com/rvb3115/WorldRenew/releases/tag/v0.5.3-test.1). Verify the matching SHA-256 checksum before opening.

- [Download Windows x64 portable EXE](https://github.com/rvb3115/WorldRenew/releases/download/v0.5.3-test.1/WorldRenew-0.5.3-windows-x64-portable.exe)
- [Download Apple Silicon Mac app ZIP](https://github.com/rvb3115/WorldRenew/releases/download/v0.5.3-test.1/WorldRenew-0.5.3-macos-arm64.app.zip)
- [Download reviewed public source ZIP](https://github.com/rvb3115/WorldRenew/releases/download/v0.5.3-test.1/WorldRenew-0.5.3-public-source.zip)

The application source is distributed in the explicitly named public-source ZIP above. GitHub’s automatically generated Source code archives for this initial release tag contain only the repository bootstrap, not the application.

- Windows x64: run `WorldRenew-0.5.3-windows-x64-portable.exe`. It needs no installer or administrator rights, extracts its runtime temporarily, and stores settings in normal application data.
- Apple Silicon, macOS 13+: extract `WorldRenew-0.5.3-macos-arm64.app.zip`, then open `WorldRenew.app`. The app has a local ad-hoc seal, without Developer ID signing or notarization.
- There is no delivered Intel Mac build. Unidentified-publisher prompts may occur; do not disable system security globally.

## Current features and format limits

- Local Java world metadata/dimension inspection, structural checks and chunk map.
- Bulk chunk protection, buffers, external plans, fresh previews and byte-verified copies.
- 3D exploration and exact rectangular build selection, saved selections, local textures/models and conflict previews.
- Portable `.wrbuild` archives that can be reopened without the source world.
- Experimental regeneration export: exact stable Java **26.3 / DataVersion and Version.Id 5023**, namespaced Overworld only. Requires review and acknowledgments, keeps a verified backup, removes selected terrain/entity/POI records only from a new result copy, and checks preservation. Minecraft generates missing terrain when the copy is loaded. The app does not generate terrain or upgrade a save.
- Restricted copied-world build placement: exact **26.2 / 4903**, supported building blocks, same vanilla dimension and validated surrounding chunks. Entities, inventories/block entities, POI, scheduled updates and other unsupported dependencies block placement. 26.3 archives can be read/previewed but cannot be placed.
- Optional update checking and verified download staging exist, but the release repository/public keys are **unconfigured**. Publishing a GitHub release does not remotely update installed copies. Automatic installation is not implemented; download and replace test builds manually.

General world merging, terrain blending, farm adaptation, Nether/End regeneration, arbitrary rotation and version upgrades are not implemented. Blocks/files preserved does not mean a farm works or a portal connects. Bedrock and modded worlds are unsupported.

## Build and test

Extract `WorldRenew-0.5.3-public-source.zip` and enter its `WorldRenew` folder first. The 99-file snapshot contains source, tests, build scripts, pinned dependencies, native CI workflow and sanitized audit evidence.

Use Node 22.12+ (audited with 24.19.0), npm and a local writable checkout. Dependencies are pinned in the lockfile.

```sh
npm ci
node qa/run.mjs --full
npm start
```

On Windows PowerShell, use `npm.cmd` if script execution policy blocks `npm.ps1`. Do not copy node_modules between operating systems.

```sh
npm run build:test:macos    # Apple Silicon Mac distribution
npm run build:test:windows  # Windows x64 distribution
npm run test:packaged       # Run on the matching native OS/architecture
```

Automated tests use synthetic fixtures; do not open those fixtures in Minecraft. For later gameplay acceptance, see `qa/vanilla/README.md` in the source ZIP. Existing smoke tests use isolated app profiles and test-owned copies. Do not run opt-in real-save scripts against valuable worlds.

## Evidence and provenance

The initial test artifacts were built from private development commit `9f8795777b982288c3881d1cf31eefb58a496065`. This public source snapshot retains identical application code; historical reports containing private world labels/local paths and private Git history are intentionally omitted. The existing development repository and workstreams are unchanged.

On October 15, 2026, an independent audit reran **182 tests, all passing with no skips**, and tested the actual extracted Mac distribution through inspection/protection/export, 3D transfer/Nether-roof preview, and build-archive/copied-world placement. Both release files matched checksums. The two distributions contain byte-identical application archives (1,340 files); Windows execution is still untested. See the `audit/` directory in the source ZIP.

Both OS builds use the same world-format gates and operation logic. Platform differences are native menus/window lifecycle, dialogs, filesystem paths/permissions, installed-client texture locations, runtime packaging and update-package selection. Source parity is verified; full native runtime parity is pending Windows tests.

This is a public code snapshot, not a grant of an open-source license. Bundled third-party software retains its own licenses. No Minecraft game assets, saves or client/server JARs are included. WorldRenew is independent and is not affiliated with Mojang or Microsoft.
