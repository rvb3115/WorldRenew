# Vanilla fixture execution protocol — NOT YET RUN

The automatic suite uses synthetic format fixtures. This pack is an **unexecuted game-fixture scaffold**, not evidence that Minecraft accepted an exported world. It has no automatic load/tick function and is not installed by the QA runner. No Minecraft jar, original save, account data or Realm connection is included.

## Create the disposable source

1. In unmodified Java **26.3**, create a new Creative world named `WorldRenew-QA-DISPOSABLE-26.3`, seed `12345`, commands enabled. Use a separate game directory. Do not reuse a survival world. Record the game build, platform, seed, difficulty, simulation distance and enabled packs.
2. Close the game. Copy this `datapack` directory into only that new world's `datapacks/worldrenew_qa` folder. Reopen the new world, run `/reload`, and confirm the pack loads without errors. The declared data-pack format 121 comes from Mojang's 26.3 release notes. Runtime command acceptance has not been tested here.
3. Run `/tag @s add worldrenew_qa_disposable`, then `/function worldrenew_qa:setup`. Visit all three dimensions and inspect the command log. If unloaded-position errors occur, visit the specified area and retry that dimension's function. Internal dimension functions are destructive setup helpers for this disposable world only.
4. Inspect and record the Overworld platform, hopper/chest/bed/rail/comparator, villager, portal frame; Nether Y127 access hole and Y128 hub; End scaffold and gateway. Record actual gateway block-entity data using `/data get block 8 65 8` in the End. Establish a known destination through the game's actual codec and test travel before treating it as a gateway fixture. The scaffold intentionally makes no assumption about a future gateway schema.
5. Add 17 diamonds, 8 pearls in the Ender chest, XP and a respawn anchor for each of three test players; log them out respectively in Overworld, Nether hub and End platform. Record actual UUIDs, inventory contents and coordinates privately. The one-player setup command does not establish multiplayer evidence.
6. Save, quit, and verify all servers are stopped. Snapshot the closed fixture into `source`, `backup` and a separate test workspace. Keep the source closed throughout export. Never relabel a save's DataVersion.

## Export and acceptance record

Use WorldRenew's existing UI or engine review/export API. Protect chunk `(0,0)` in all three dimensions and End destination chunk `(6,0)`; retain all portal-network dependency chunks identified during baseline traversal. Review Overworld chunk `(4,0)` with buffer 1 and inspect player-safety blockers. The golden marker in that chunk is intentionally disposable. Nether/End removal remains unsupported.

Before game load, run the same independent hash/record comparisons used in `qa/preservation.test.mjs` on **copies**. Confirm all protected chunk records, player files, Nether/End stores and global metadata match the closed source. Do not expect whole-file equality after the game subsequently saves normal runtime changes.

Then open **only the exported test copy** in the same vanilla version. Visit the removed chunk and verify regeneration, save/quit/reopen twice, and capture logs/screenshots. Test each player login, inventory, dimension, coordinates and respawn. Walk through the roof hole and ladder. Traverse every portal both ways, including competing nearby portals; record actual arrival coordinates. Traverse the End gateway both ways and check its destination and dragon-fight state. Compare stable semantic data after reload, not timestamps or ticking entity fields.

This scaffold contains representative farm components, **not working iron or enderman farms**. Farm certification needs a separate known-working baseline with the full villagers/beds/POI or endermite/spawning/transport system. Measure pre/post output for the same loaded duration, AFK location, mob cap, difficulty and simulation distance across repeated trials. Record failures separately from preserved blocks. No automatic adaptation or universal farm functionality is claimed.

Record one result per case as `passed`, `failed`, or `not-run`; include exact version pair, operation, source/output hashes, game logs, player/portal observations and farm measurement conditions. Until those artifacts exist, `gameLoadTested`, `portalConnectivityValidated` and `farmFunctionalityValidated` remain false. A green synthetic test run must never change those fields.
