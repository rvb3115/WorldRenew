# Regeneration backup recovery

Status: implemented for local 0.5.12-test.1 testing. Not a published release or Minecraft gameplay certification.

## User workflow

Use **Recover a backup…** in the sidebar, even before opening a world. Choose the completed regeneration export directory, or its hidden `.WorldRenew-regeneration-….partial` directory after an interruption. The native chooser includes hidden folders. Select the transaction folder containing `operation.json`, not its `world` subfolder.

The dialog checks the retained backup and shows one of three states:

| State | Meaning | Action |
| --- | --- | --- |
| Backup verified | Complete inventory and every file checksum match the retained manifest. | Close Minecraft/servers using this backup, acknowledge that in the dialog, and choose an output folder. |
| No completed backup available | A finished backup or its manifest is missing. | Keep the transaction unchanged; an incomplete copy cannot be restored by this workflow. |
| Backup could not be verified | Metadata, paths, inventory or bytes failed validation. | Read the displayed reason and preserve the transaction for investigation. |

Recovery creates `WorldRenew-recovery-<uuid>/world` in the chosen output folder. The containing directory also includes `manifest.json` and `recovery.json`. **Show recovered copy** opens that new location. Recovery does not overwrite the original save, retained backup, existing export result or another recovered copy. A canceled folder choice writes nothing.

The backup is checked again before and after copying. A changed journal, manifest, inventory, identity or file invalidates the review; choose the export folder again to review its current state. Completion means the copied files match the retained backup. It does not mean Minecraft has loaded the copy, that the files came from an authenticated source, or that gameplay works.

## Decision: recover the retained backup into a new directory

This implements the recovery-inventory and new-directory restore part of the master design's M1/A13 interruption work. The exporter already retains a verified backup when its working-copy phase fails, but the desktop previously offered no way to inspect and restore that retained backup after restarting.

We considered three approaches:

1. Resume the incomplete regeneration result. Rejected: the journal does not establish that all writes and validations completed, and replay would need a separate versioned transaction protocol.
2. Restore over the original save. Rejected: the original may have newer changes and might be the only remaining independent copy.
3. Verify only the retained backup and copy it into a new owned directory. Selected: bounded, reviewable and independent of the original source's availability or Minecraft semantics.

The existing generator boundary is unchanged: the exporter supports exact stable Java 26.3 / DataVersion 5023, namespaced Overworld only, and removes reviewed terrain/entity/POI records in its own separate copy. Minecraft generates missing terrain on load. Recovery performs no generation, conversion, merge, blending, repair, record removal or result promotion. Nether/End regeneration, unsupported writer formats, mod support and live Realms remain outside scope.

## Data and trust boundaries

- Accept only supported schema-1 regeneration journals and recognized retained-backup locations under the selected transaction. Journal source/result strings are descriptive; recovery never opens either original world or prior result.
- Support a normally labeled `backup/world` and the constrained generated-copy child left by a failed backup-label rename. A `backing-up` journal can discover one unambiguous completed retained-backup candidate. Multiple candidates, unknown journal states and incomplete `.partial` children are blocked.
- Require the manifest's source metadata to match the journal and reject known result-manifest markers. These are consistency checks, not authenticated provenance: journals/manifests are unsigned.
- Normalize Windows and POSIX relative separators, then reject traversal, absolute/drive/stream paths, reserved or ambiguous names, case/Unicode collisions, duplicate entries, omitted parents, links and special files. Preserve both files and empty directories.
- Compare exact inventory, sizes and SHA-256 hashes. Read through bounded streaming buffers, bind the review to stable file identities and metadata, and recheck inputs around copying.
- Keep paths and the inspected digest in the Electron main process. Renderer requests carry a digest and explicit closed-world confirmation; folder paths come from native choosers. Verification/copying runs in a worker and reports progress.
- Require output outside the selected transaction and Minecraft saves. Known open-world roots are exclusion strings, not paths to reopen. Build a unique hidden staging directory, verify the complete new tree, write the manifest/report, then publish by rename. On an ordinary failure remove only staging still owned by that attempt.

Limits are 1 MiB journal metadata, 64 MiB manifest metadata, 200,000 inventory entries, 64 directory levels, and 1 MiB file streaming buffers. Files are hashed multiple times to detect stale inputs; larger backups can take time. The app blocks closing its recovery operation while it is working. It does not obtain an operating-system lock on another application, and no runtime Cancel action or automatic resume is provided.

## Verification and remaining acceptance

`node --test tests/regeneration-recovery.test.js` exercises completed and interrupted backups, exact file/directory preservation, stale inputs, unsupported metadata, path and link rejection, disk/write failures, ownership-aware cleanup and process termination using generated fixtures. `node scripts/smoke-recovery.mjs` exercises the real desktop bridge with native dialog choices stubbed to generated fixture paths: cold-start recovery without an available source, confirmation gating, canceled choices, stale review rejection, completed/interrupted restore, missing/invalid states, reveal and busy-dialog behavior. It records screenshots and source/export hashes in `work/recovery-smoke-*/results.json`. The packaged smoke suite includes the same workflow.

The full engine/QA suite remains required, together with the macOS packaged suite and matching Windows application payload verification. Native Windows execution, real Minecraft load/save/reopen, power-loss durability and gameplay acceptance remain pending. Process-kill and injected-I/O tests cover their named boundaries only; they do not establish every possible failure interleaving or full filesystem durability.

A process killed during recovery can leave its hidden staging directory. It is not a published recovered world and is never automatically resumed or adopted. The retained input backup remains the starting point for another recovery attempt.
