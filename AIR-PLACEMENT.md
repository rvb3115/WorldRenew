# Air in portable builds

A complete rectangular selection records every block, including `minecraft:air`, `minecraft:cave_air` and `minecraft:void_air`. Saving a template never drops enclosed air. Unknown or unreadable data prevents archive capture; it is never substituted with air.

The placement pane offers two explicit modes:

- **Include captured air** (default): place the exact captured air variant. This clears destination material and preserves rooms, tunnels and other voids.
- **Skip captured air**: leave destination blocks unchanged at all three captured air variants. Underground interiors may remain filled. Other supported source blocks still replace the destination normally.

`minecraft:structure_void` remains its own state and is not an implicit mask. Its placement semantics are unsupported, so the existing writer gate blocks it. Unknown source or destination data remains a blocker even in skip mode.

The preview reports changed blocks, blocks cleared to air, skipped positions, each captured air variant, structure-void and unknown counts. The proposed view uses the chosen mode. Changing modes clears the reviewed preview and closed-world acknowledgment; the review digest and writer both bind the mode. A separate copied world is read back to verify the expected exact states, including retained destination blocks in skip mode.

Both modes retain existing version, dimension, supported-block, attachment, neighbor, protection and copy-validation gates. No source world is edited. The writer is still limited to exact Java 26.2 / 4903 supported building blocks; 26.3 archives are capture/preview only.

Automated coverage: `tests/air-placement.test.js` builds an enclosed room containing all three air variants, tests both copied outcomes, stale review rejection, unknown chunks and structure-void. `scripts/smoke-archive.mjs` checks mode counts and acknowledgment invalidation through the real desktop UI.
