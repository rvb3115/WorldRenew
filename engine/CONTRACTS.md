# World Engine interface contract

Owner: World Engine, branch `feature/world-engine`. Shared application baseline: 0.5.3. Coordinate changes with Desktop App & Updates and QA before changing public result shapes or enabling a new writer. Other workstreams consume the same engine modules in the unified application.

## Read-only block state adapter

`decodeSection(section)` in `chunks.js` accepts these disk palette entries:

- Legacy compound: `{Name: 'minecraft:oak_stairs', Properties: {facing: 'north'}}`.
- Current compound: `{id: 'minecraft:oak_stairs', properties: {facing: 'north'}}`.
- Compact state: `'minecraft:stone'`.

The return remains `{y, palette, indices}`. Every palette value is normalized to `{Name, Properties?}` and `indices` remains a 4096-element Uint16Array. `stateKey`, `isAir`, `isFluid`, volume scans, archive comparisons and the renderer retain their existing contract. The raw input and archived typed NBT records are not rewritten by this decoder.

An entry with both `Name` and `id`, mismatched property casing, non-string property values, malformed IDs, missing names, arrays or invalid state objects fails with `BLOCK_STATE`. Unknown section content must remain unknown/error rather than turning into air. Palette packing and existing size/bounds checks are unchanged. This is syntax decoding, not a game registry or block-validity certificate.

## Existing public engine operations

- `inspectWorld(folder, progress?)`: reads metadata and record structure; returns metadata, dimensions, validation errors and inventory fingerprints. Never writes a source.
- `createRegenerationReview(world, selected, protection, options?, progress?)`: read-only schemaVersion 1 review, non-executable, with playerSafety and copyExport blockers. A desktop preview must retain its digest and invalidate it after changed selections/protection/options.
- `createRegeneratedCopy(world, review, outputParent, acknowledgements, progress?)`: revalidates the retained review, requires both confirmations, owns backup and working copy, and returns paths only after validation. A caller cannot supply an existing writable destination world.
- `createVerifiedCopy(source, outputParent, {confirmedClosed}, progress?)`: full verified snapshot, with an external manifest. This does not upgrade a Minecraft save.
- `createChunkReader`, `captureVolume`, archive capture/validation and placement previews retain their existing function signatures and normalized block-state values.

No new IPC endpoint, renderer schema, package dependency or update service call is required for the palette adapter. Application updates must never trigger engine mutation. Regeneration remains restricted to exact stable 26.3 / 5023 namespaced Overworld copies; block placement remains restricted to its separate 26.2 adapter. Decoder support alone must never widen those gates.

## Validation boundary

QA owns independent conformance fixtures under `qa/`, including current compounds, compact strings, legacy compounds, state-property retention and ambiguous input rejection. Engine regression tests must still pass. Real game loading, palette registry validity, farm mechanics, merging and blending remain separate validation gates. No original Minecraft world is modified for these tests.
