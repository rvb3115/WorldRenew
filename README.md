# WorldRenew 0.5.5-test.1 development test builds

Standalone desktop tools for inspecting and preserving Minecraft Java Edition worlds. One shared application for Windows x64 and Apple Silicon macOS; no mod or separate Java/Node installation is required for packaged builds.

**Experimental, unsigned test builds. Use disposable world copies only. Minecraft game-load, multiplayer login, portal travel, farm functionality and terrain continuity are not certified. Native Windows installer/runtime validation and Minecraft gameplay acceptance remain pending.**

## Development branch

`feature/detailed-terrain` contains the next local test build. **0.5.5-test.1 has not been published as a release.** The released 0.5.4 files remain unchanged.

- [Detailed terrain map](TERRAIN-MAP.md): saved block colors and elevation shading, chunk grid, coordinate navigation, selection/protection, bounded asynchronous tiles and dimension-aware Nether cavern/roof views.
- [Local template library](LOCAL-TEMPLATES.md): named portable builds, import/export, drag-and-drop, safe duplicate names and reopening without the source world.
- [Air-placement modes](AIR-PLACEMENT.md): preserve captured air or explicitly skip it, with counts and a fresh review before writing a separate copy.
- [Vanilla/datapack compatibility](VANILLA-COMPATIBILITY.md): preserve recorded configuration without treating experimental flags as a blanket rejection.
- [Windows installer](WINDOWS-INSTALLER.md): persistent per-user installation, Start menu/desktop shortcuts and retained app data on upgrade/uninstall. Native installation testing is still pending.

## Published 0.5.4 downloads and launch

Get the Windows portable EXE or Apple Silicon app ZIP from [the experimental prerelease](https://github.com/rvb3115/WorldRenew/releases/tag/v0.5.4-test.1). Verify the matching SHA-256 checksum before opening.

- [Download Windows x64 portable EXE](https://github.com/rvb3115/WorldRenew/releases/download/v0.5.4-test.1/WorldRenew-0.5.4-test.1-windows-x64-portable.exe)
- [Download Apple Silicon Mac app ZIP](https://github.com/rvb3115/WorldRenew/releases/download/v0.5.4-test.1/WorldRenew-0.5.4-test.1-macos-arm64.app.zip)
- [Historical 0.5.3 source ZIP](https://github.com/rvb3115/WorldRenew/releases/download/v0.5.3-test.1/WorldRenew-0.5.3-public-source.zip)

The updated source is browsable in this repository and in the Source code archives for tag `v0.5.4-test.1`. The explicitly named 0.5.3 source ZIP is historical and does not contain the parser fix.

- Windows x64: run `WorldRenew-0.5.4-test.1-windows-x64-portable.exe`. It needs no installer or administrator rights, extracts its runtime temporarily, and stores settings in normal application data.
- Apple Silicon, macOS 13+: extract `WorldRenew-0.5.4-test.1-macos-arm64.app.zip`, then open `WorldRenew.app`. The app has a local ad-hoc seal, without Developer ID signing or notarization.
- There is no delivered Intel Mac build. Unidentified-publisher prompts may occur; do not disable system security globally.

## Parser fix in 0.5.4-test.1

Accepts exact single-empty-key binary NBT wrappers around compact block-state strings. Legacy `Name`/`Properties`, modern `id`/`properties` and plain strings retain their existing support. Valid unfamiliar IDs and properties remain exact; fallback visuals never substitute exported block data. Ambiguous encodings, inconsistent archive DataVersions and unsupported placement states remain blocked. This does not add future-schema support or a registry conversion system.

All **204 synthetic tests passed**, including a nine-chunk mixed-palette fixture and byte-exact archive export/reopen checks. The packaged Mac app passed desktop, 3D and archive/copied-world smoke tests. Windows payload verification passed; both builds contain byte-identical app archives. Native Windows execution and the real failing-world retry remain pending. The old release is preserved.

## Current features and format limits

- Local Java world metadata/dimension inspection, structural checks and a detailed terrain map for exact stable 26.2/4903 and 26.3/5023 vanilla dimensions.
- Bulk chunk protection, buffers, external plans, fresh previews and byte-verified copies.
- 3D exploration and exact rectangular build selection, saved selections, local textures/models and conflict previews.
- Local portable `.wrbuild` library and transfer files that reopen without the source world, with explicit include/skip air placement.
- Experimental regeneration export: exact stable Java **26.3 / DataVersion and Version.Id 5023**, namespaced Overworld only. Requires review and acknowledgments, keeps a verified backup, removes selected terrain/entity/POI records only from a new result copy, and checks preservation. Minecraft generates missing terrain when the copy is loaded. The app does not generate terrain or upgrade a save.
- Restricted copied-world build placement: exact **26.2 / 4903**, supported building blocks, same vanilla dimension and validated surrounding chunks. Entities, inventories/block entities, POI, scheduled updates and other unsupported dependencies block placement. 26.3 archives can be read/previewed but cannot be placed.
- Optional update checking and verified download staging exist, but the release repository/public keys are **unconfigured**. Publishing a GitHub release does not remotely update installed copies. Automatic installation is not implemented; download and replace test builds manually.

General world merging, terrain blending, farm adaptation, Nether/End regeneration, arbitrary rotation and version upgrades are not implemented. Blocks/files preserved does not mean a farm works or a portal connects. Bedrock and modded worlds are unsupported.

## Build and test

Clone this repository and check out `feature/detailed-terrain` for these changes. Use tag `v0.5.4-test.1` for the unchanged published release. The reviewed snapshot contains source, tests, build scripts, pinned dependencies and sanitized audit evidence. In the browsable repository, the CI workflow is stored as `disabled-workflows/test-builds.yml.txt`; there are no active GitHub Actions workflows. The historical source ZIP retains its original workflow file, which does not run while archived.

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
npm run build:installer:windows # Windows x64 installer
npm run test:packaged       # Run on the matching native OS/architecture
```

Automated tests use synthetic fixtures; do not open those fixtures in Minecraft. For later gameplay acceptance, see `qa/vanilla/README.md` in the reviewed source. Existing smoke tests use isolated app profiles and test-owned copies. Do not run opt-in real-save scripts against valuable worlds.

## Historical 0.5.3 evidence and provenance

The initial test artifacts were built from private development commit `9f8795777b982288c3881d1cf31eefb58a496065`. This public source snapshot retains identical application code; historical reports containing private world labels/local paths and private Git history are intentionally omitted. The existing development repository and workstreams are unchanged.

On October 15, 2026, an independent audit reran **182 tests, all passing with no skips**, and tested the actual extracted Mac distribution through inspection/protection/export, 3D transfer/Nether-roof preview, and build-archive/copied-world placement. Both release files matched checksums. The two distributions contain byte-identical application archives (1,340 files); The owner confirmed a basic Windows launch on October 15, 2026; automated native Windows runtime tests and Minecraft gameplay remain unverified. See the `audit/` directory in the reviewed source.

Both OS builds use the same world-format gates and operation logic. Platform differences are native menus/window lifecycle, dialogs, filesystem paths/permissions, installed-client texture locations, runtime packaging and update-package selection. Source parity is verified; full native runtime parity is pending Windows tests.

This is a public code snapshot, not a grant of an open-source license. Bundled third-party software retains its own licenses. No Minecraft game assets, saves or client/server JARs are included. WorldRenew is independent and is not affiliated with Mojang or Microsoft.
