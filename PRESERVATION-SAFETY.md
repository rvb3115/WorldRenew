# Stored-data preservation and operation limits

The 0.5.7 development build strengthens chunk-reset export: a selected candidate containing **any block entity or entity is blocked**, including empty containers, dropped items, mobs, inventory-bearing vehicles and unfamiliar block entities. There is no deletion override. Missing attachment lists, wrong NBT types, mismatched versions/coordinates, unreadable compression and exhausted inspection budgets also block export. Protect the entire chunk and review again.

The existing backup, closed-world confirmation, review digest and final verification remain required. No original world is opened for writing. Regeneration export still requires exact stable 26.3 / 5023 and the supported namespaced Overworld layout; placement still requires its separate exact 26.2 / 4903 adapter. Terrain support for 1.21.11 does not enable either writer.

## Player and inventory acceptance checks

Permitted exports verify the complete source and backup file inventories and hashes. Unmodified output files, including `level.dat`, remain byte-identical. This retains embedded `Data.Player`, standalone player records, UUIDs, inventory and armor slots, tools and durability, health, food level, saturation/exhaustion, XP, Ender Chest items, item components, nested NBT and unknown fields without interpreting or stripping them.

The reset player-safety review recognizes `players/data/*.dat`, legacy `playerdata/*.dat`, embedded `level.dat:Data.Player`, saved positions and modern/legacy respawn anchors. Unknown player schemas, mismatched versions/UUIDs, conflicting storage layouts, relevant vehicle dependencies and anchors near removal candidates block reset. Other untouched files, including stats, advancements and backups, are retained by the whole-tree hash checks. This is not account migration or a guarantee of safe landing/gameplay after loading.

Chest and other block-entity inventories in protected/unselected reset chunks retain their original record bytes. Selected chunks containing them cannot be reset. Placement refuses source inventory/block-entity relocation and destination block entities inside the placement. Block entities outside the footprint remain typed and unchanged, including those inside chunks whose derived lighting data is invalidated. Unselected region records are verified separately; changed region files are not advertised as whole-file byte-identical.

Focused regression fixtures cover both standalone player layouts and embedded Player, all listed equipment/status fields, nested Ender Chest containers, unknown item components and long/byte payloads. They also check raw protected-chest records, container data in a placement lighting border, late inventory changes, blocked destructive selections and unchanged originals. These are synthetic storage-format tests, not Minecraft gameplay certification.

## Special blocks

| Blocks/data | Template capture | Copied-world placement |
| --- | --- | --- |
| Glass and stained glass | Exact states and supporting raw records | Supported registered building blocks |
| Panes, fences, iron bars | Connection properties retained | Blocked; connection/neighbor relocation not implemented |
| Stairs | Facing, half, shape, waterlogging retained | Selected registered materials, dry states only; no rotation |
| Slabs | Top/bottom/double and waterlogging retained | Selected registered materials, dry states only |
| Doors | Half, hinge, facing, open/powered retained | Blocked; paired-half relocation/validation not implemented |
| Nether portal blocks | Axis/state retained; coordinates can be reviewed | Blocked; portal links are not validated or recreated |
| Redstone and related mechanisms | Stored states and supporting tick/entity records retained | Blocked by the restricted placement adapter |
| Inventories, block entities, entities, scheduled ticks, POI | Supporting raw records retained with typed metadata | Relevant dependencies block placement; no relocation adapter |

Archive capture is limited to its supported 26.2/26.3 formats. It saves selected blocks and air plus full supporting terrain/entity/POI chunk records, which can include surrounding data. It does not certify that a selection contains both door halves, a complete circuit or every connected structure. Unknown visual colors/models do not replace stored block states.

Placement translates supported states without rotating or recomputing neighbor connections. A complete matching-version one-chunk lighting border is required, including across negative coordinates and region boundaries. A saved stair shape may change when Minecraft updates neighboring blocks. Stored state equality does not prove a redstone machine, farm, portal network or multi-block structure works after loading.

Reset intentionally removes the selected terrain records. Even with the inventory/entity guard, selected glass, fences, stairs, doors, portal blocks or redstone can be removed, and neighboring mechanisms can be affected. Protect complete builds and circuits across chunk boundaries. Protection buffers reduce exposure but do not certify connectivity.

WorldRenew does not generate terrain itself: Minecraft regenerates missing chunks when the exported copy is loaded. General world combining, terrain blending, arbitrary transformations/rotation, version upgrades and adaptation of farms/redstone machines remain unimplemented. Raw data retention and gameplay behavior are separate acceptance criteria.

## Implementation boundary

`removal-safety.js` decodes one candidate at a time and checks compound-list tag types as well as contents. The aggregate raw-content budget is 256 MiB; per-record decoder limits still apply. A record that crosses the aggregate budget is rejected, and remaining candidates are not authorized. New safety results participate in review digests and are recomputed before both copying and editing. Exports report the completed attachment checks and byte-identical player/level data validation.
