# Work Session 3: preservation QA and merge/seam research

This extends the existing WorldRenew application. It creates no separate app and changes no production engine, desktop, update or package files. Owner: `feature/world-merging-tests`, paths `qa/**`. Tests consume Session 1's committed reader fix `d7f593a`; initial shared baseline is `fe17e84`.

## Reproduce the small workflow

From this repository checkout, using Node >=22.12:

```sh
node qa/run.mjs
node qa/run.mjs --full
```

The first command runs the 41 Session 3 tests; `--full` includes existing regression tests. Each run creates a new `qa/runs/run-*/evidence.json` and `tests.tap`, returns a failing exit code if tests fail, and records code hashes, commit/branch, working-tree state, Node version, counts and explicit unproven capabilities. No package changes or external services are required. Generated NBT/Anvil worlds live in uniquely owned temporary directories and are removed after each test. No save path is accepted from the user and no game/Realm is launched. The fixture writer refuses to initialize an existing directory.

Recorded initial result (October 14, 2026): **41/41 QA tests and 178/178 combined tests passed**, with no skips or TODOs. A detached integration checkout combining QA `03e7bc5`, engine `d7f593a`, and desktop `c06227e` passed **182/182** tests. Main was not merged. See `evidence/` for retained machine-readable evidence and TAP output. Passing synthetic tests does not certify real saves or game mechanics.

## Evidence and boundaries

| Area | Automated evidence | Still unproven |
| --- | --- | --- |
| Protected builds and buffer | Whole records at `(0,0)` and neighboring `(1,0)` retained; only distant Overworld `(4,0)` records removed from the working copy | Structures/dependencies outside selected columns; gameplay after regeneration |
| Original and backup | Independent recursive SHA-256 inventories; every file matches; all output file names retained; only selected header bytes differ | Concurrent Minecraft writer, power loss and OS locking |
| Players | Three UUIDs in three dimensions; exact saved files plus inventory/count, Ender chest, XP, position, respawn, stats/advancement bytes | Account remapping, actual login, inventory conversion and safe landing |
| Overworld/Nether/End | Terrain/entities/POI retained independently, including negative and region-boundary coordinates; only approved Overworld records removed | Nether/End regeneration remains blocked |
| Nether roof | Air access hole, adjacent bedrock, ladder properties, hub platform and portal block retained | Pathfinding/traversal, usable hub after game loading |
| Portals | Both endpoint blocks retained; 8:1 coordinate hint checked; `linksValidated` stays false | Actual destination selection, competing portals, return trip |
| End gateway | Gateway attachment/exit coordinates, destination chunk and opaque global End data retained | Gateway travel and dragon-fight semantics |
| Farms | Hopper/chest contents, bed/rail/comparator, villager/endermite records and POI preserved | Functional farm design, spawning/output, upgrade adaptation |
| Palette compatibility | Legacy, 26.3 `id/properties`, compact strings, invalid/ambiguous rejection and packed index boundary vectors | Registry validity and all real-world palettes |
| Archive capture | Current-format NBT → volume → saved/reopened portable archive, raw supporting records unchanged | 26.3 archive placement remains blocked by the existing writer policy |
| Merge/seams | Read-only conflict and diagnostic tests; no writer | General merging and seamless blending |

`fixtures.mjs` generates deliberately incomplete **synthetic Java-format** worlds. Tick lists are explicit; blocks use 26.3 disk fields. Some records are structural sentinels, not game-generated schemas: stats/advancements and dragon-fight metadata contain fixture-only fields, blocks are representative components and biomes/lighting/complete terrain are omitted. These fixtures must not be presented as playable vanilla worlds. The separate [vanilla setup pack and protocol](vanilla/README.md) are prepared but not game-executed.

## Integration contracts

These are QA-only contracts, not production API proposals. Production contracts remain in `engine/CONTRACTS.md`.

- `createFixture(newRoot, options?)`: test-owned creation only. Source is never a production save. Three dimensions, three players and per-store records; returns the new root.
- `previewRegionImport(sourceRoot, destinationRoot, request)`: read-only, at most 64 unique chunks. `dimensionId` is a namespaced ID; `offset` is in **chunks**; protection entries are `{dimension: namespacedId, x, z}`. This differs deliberately from the engine's layout-specific protection keys and must not be passed directly to engine exporters. Returns `schemaVersion:1`, `executable:false`, mappings, per-store conflicts, world blockers, selected-record UUID collisions and unresolved dependencies. No clean preview can authorize an import.
- `inspectSeam(sourceRoot, destinationRoot, request)`: paired block columns with explicit Y window, up to 8,192 block pairs. Returns occupancy mismatch, unknowns, fluids, bedrock, protected samples and bounded top-height differences. `blended:false` and `seamlessnessProven:false` are unconditional. It produces no changed terrain.
- `run.mjs`: evidence schema 1. A successful test exit only sets the test result; game-load, portal-connectivity, farm-functionality and merge/blending status remain false.

Session 1 owns engine changes. Integrate the reader fix before these QA tests. Any future merge writer needs a separately reviewed relocation/dependency API, immutable preview digest, explicit collision policy, verified backup, owned output path, and post-write/game validation. No changes to shared interfaces were needed here.

Session 2 may invoke the runner in CI using `node qa/run.mjs --full` once a repository/CI exists. Do not infer UI capability flags from a green test run or silently enable unsupported writers. Keep the phrases “blocks/files preserved” separate from “farm works”, “portal connects” and “game-load tested”. Retain release-version and engine-code provenance when exporting reports. No updater paths or settings are touched by QA.

## Research conclusions

A region filename is a container, not a conflict-free merge unit: all terrain/entity/POI records at a destination coordinate require review. The prototype treats any occupied store as a conflict, even identical payloads, and catches entity/POI stores without terrain. Integer translation handles negative boundaries using floor division; it does not relocate NBT coordinates. A clean empty destination still needs version/seed, structures, tick lists, block entities, passenger trees, global UUIDs, portals, maps and global metadata work. UUID checks here cover **only selected destination records**, not the entire world; therefore absence of a collision proves little.

The seam experiment proves a narrower negative result: equal top heights within a window can coexist with a cave discontinuity. Missing chunks stay unknown, and fluid/bedrock/protected samples are surfaced. Height interpolation alone cannot establish biome, aquifer, cave, structure, lighting or gameplay continuity. A future blend solver must hold protected cells and Nether bedrock fixed, preserve access holes as air, and reject unresolved content/dependencies. No smoothing algorithm or Minecraft generation hook is implemented.

Mojang's [Java 26.3 release notes](https://www.minecraft.net/en-us/article/minecraft-java-edition-26-3) specify `Name`→`id`, `Properties`→`properties`, compact default states and data pack version 121. This motivates the codec tests and pack metadata, not gameplay certification. Mojang describes [1.18 world blending](https://www.minecraft.net/en-us/article/caves---cliffs-part-ii-the-features) for new generation meeting existing old-world chunks. Its [1.19 notes](https://feedback.minecraft.net/hc/en-us/articles/6731464524941-Minecraft-Java-Edition-1-19) describe version-specific `blending_data` changes. Our inference: those mechanisms do **not establish** arbitrary cross-world/cross-seed import blending. Do not forge blending or DataVersion metadata to imply support. Sources checked October 14, 2026.

## Next gates

1. Execute the provided fixture protocol in a new vanilla world, capture exact version/seed/pack hashes and actual saved schemas. Keep results `not-run` until evidence exists.
2. Validate close/export/open/save/reopen and the three test-player logins; test both directions of portal/gateway travel.
3. Add known-working iron and enderman farm baselines with controlled conditions and measured output. The current blocks are sentinels, not operational farm templates.
4. Before a production merge, define whole-world UUID/dependency inventory, relocation rules, duplicate/missing record policy and global metadata ownership. Whole-region replacement is not an accepted strategy.
5. Compare seam diagnostics against game-generated same-seed and different-seed cases, including caves/fluids/biomes and protected roof access, before choosing a blending approach.
