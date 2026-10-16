# Regeneration and recovery desktop validation

October 16, 2026. Installed application: **0.5.12-test.1**, runtime source commit `5fb7d972be90846918a043c04386b145b7491839`, application payload SHA-256 `2e1679fc7681047320adf242a38961a3481d544df47ae2238682aad58192af34`. This increment adds a reproducible desktop acceptance test and fixes Windows separator handling in the preservation test. It changes no engine, UI or desktop runtime behavior, so no new candidate or installation is needed.

## Verified workflow

`npm run test:regeneration-roundtrip` runs three real Electron sessions against newly generated fixtures. Native folder dialogs are stubbed to owned paths; the normal UI, preload bridge, main process, workers, review/export and recovery code execute unchanged.

1. Open a three-dimension synthetic world, protect the core in every dimension and the End gateway destination, save the protection plan, and select Overworld `(0,0)`, `(1,0)` and `(4,0)`. Preview excludes the protected core and one-chunk buffer. Both export acknowledgments are required.
2. Export the remaining `(4,0)` candidate. Independent SHA-256 inventories and a separate Anvil header/record reader prove that all 39 source and backup files match. Exactly six bytes change in each of the selected terrain, entity and POI files: offsets `18`, `19`, `4112`–`4115`. All remaining bytes, records and player files remain identical. The exported copy has 18 terrain chunks, down from 19.
3. Quit WorldRenew normally. Rename only the generated source to make its recorded path unavailable, and replace only the generated result's `level.dat` with deliberately invalid test bytes.
4. Start WorldRenew again with the same isolated profile and no world open. Verify the retained backup, acknowledge that it is closed, and create a separate recovered copy. All 39 original files and the empty directory match the baseline; the retained transaction, including the deliberately invalid prior result, stays unchanged.
5. Quit and start again. Open the recovered copy in WorldRenew: all 19 indexed terrain chunks and three dimensions return, and reviewing `(4,0)` finds all three restored stores. Reinspection changes no world bytes.

All three sessions completed without renderer errors or lifecycle loss before the explicit harness close. Each owned main process then exited with code `0`, signal `null`. This does **not** resolve the earlier intermittent 3D preview closure; its classification remains [unresolved](SMOKE-CLOSURE-INVESTIGATION.md).

The fixture is deliberately synthetic and incomplete, not playable Minecraft terrain. Missing vertical sections appear as unreadable terrain in map screenshots. This workflow validates byte preservation, desktop transactions and reopening the recovered directory in WorldRenew; it does not validate Minecraft loading, generation, player login, portal travel or farm behavior.

## Local evidence

Final installed run: `work/regeneration-roundtrip-apYZtj/results.json`, with five screenshots and per-session lifecycle logs. Preservation wrapper: `work/regeneration-validation/run-yE2Q0E/verification.json`. It verifies that the installed payload, prior 0.5.11 backup, existing Mac ZIP, Windows installer and all 321 normal-profile entries remain unchanged. An earlier run also passed before the host-separator-only test adjustment.

Full engine and QA suite: **454/454 passed**, zero failed/skipped/TODO; `qa/runs/run-RGJua7/evidence.json` and `tests.tap`. Final test evidence is copied into `artifacts/regeneration-roundtrip-evidence/`, together with screenshots, lifecycle logs, the unchanged-profile/artifact verification and the Minecraft gate report.

The test is now part of `scripts/smoke-packaged.mjs` for both platforms. This task tested the installed Mac payload directly; it did not rerun the entire packaged suite or claim native Windows execution. Existing 0.5.12 distribution metadata remains tied to the original runtime commit and hashes.

## Minecraft execution gate

Read-only installation inspection found vanilla **26.3**, embedded world version **5023**, and an installed Microsoft OpenJDK **25.0.1** ARM64 runtime. Only version metadata, libraries and runtime files were inspected; no user saves or account credentials were opened. The installed classpath ran Minecraft's GameTest help and the dedicated-server settings initializer successfully.

The GameTest command's `--universe` option explicitly replaces an existing folder. It cannot demonstrate loading and saving the exported copy, and was not used as a substitute.

Running `net.minecraft.server.Main --initSettings` in a new QA directory created `server.properties` and **`eula=false`**. It did not start a world or server. No existing accepted dedicated-server setup was found in the task workspaces. The instruction for this task prohibits accepting new agreements, so that setting remains unchanged. No server JAR was downloaded and no normal Minecraft launcher profile was modified.

To perform the real Minecraft load/save/reopen gate, use an already approved disposable vanilla 26.3 setup, or have the user complete the required agreement/setup themselves. The separate [vanilla fixture protocol](qa/vanilla/README.md) remains unexecuted. Do not feed the synthetic fixture used above to Minecraft as though it were a valid game-generated world.

Raw probe evidence is retained under `work/minecraft-probe/`: installed-tooling metadata, `gametest-help.log`, and `server-settings/command.log` plus the unaccepted `eula.txt`. The acceptance bundle contains a concise machine-readable gate report. `gameLoadTested` remains **false**.

Native Windows execution, real Minecraft generation/load/save/reopen, player/portal/farm acceptance and power-loss durability remain outstanding. No release, binary upload, user-world modification or app replacement occurred in this increment.
