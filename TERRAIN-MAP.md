# Terrain preview (local 0.5.7 test build)

The map reads block states into a 16×16 pixel tile per chunk. Water, shorelines, foliage, roofs and terrain materials now appear with approximate material colors and elevation shading. Point at a column for block coordinates, material and height. Selection tint and outlines preserve the visible terrain; protection, 3D bounds and regeneration reviews retain their existing workflows.

Drag to select chunks, right/Shift-drag or choose Pan to move, and scroll or use +/− to zoom. Arrow keys pan the focused canvas. Go accepts block coordinates; protection selection inputs accept chunk coordinates. North is up. Fit selection zooms to an area without changing it.

An optional [3D topographic view](TOPOGRAPHIC-MAP.md) presents those same surface elevations as a tilted, selectable mesh. It keeps a bounded 11×11 chunk window and does not represent interiors.

## Interpretation and limits

- Stable vanilla Java 1.21.11 (4671), 26.2 (4903) and 26.3 (5023) only. The [1.21.11 adapter](TERRAIN-1.21.11.md) validates its legacy compound palette schema. Unknown versions, custom dimensions, unexpected section heights and unsupported chunk versions stay explicitly unsupported. This does not expand any export or 3D-capture gate.
- Surface shows the highest non-air block, including leaves and buildings. Colors are approximate, without resource-pack textures or biome tinting; unfamiliar materials use a disclosed purple fallback. Exact block data is untouched.
- Nether defaults to the highest surface below Y 128 with at least three air blocks above it. It can hide smaller tunnels and covered floors. Roof shows Y 128–255 only. Cutaway shows the highest non-air block at or below a chosen Y; it is not a walkability calculation.
- Missing chunk records are absent. Pending records use slate tiles. Unreadable records/regions use diagonal error stripes with reasons on hover. All-air columns are decoded empty space, not missing chunks. Missing block sections, bad palettes, damaged files and unsupported compression are never substituted with air.
- With more than 1,024 visible chunks, the map labels itself a chunk-index overview and asks the user to zoom in. No background whole-world terrain scan runs. Existing header inspection still has the original million-chunk/20,000-region limits.
- One dedicated worker reads at most 16 chunks per request. A 20-second request timeout and 256 MiB JS heap guard prevent unbounded work. Both worker and renderer cache at most 2,048 projected tiles, plus up to 128 small region overview images in the renderer. Expanded chunk data is not retained in the tile cache. Worker cache hits check region and external payload stamps.
- Displayed tiles are session snapshots. Refresh rescans the index and discards both caches. World changes detected during loading invalidate the affected read; close Minecraft during inspection.

## Verification

`node --test tests/terrain*.test.js` checks columns, materials, roof/cavern/cutaway behavior, void, unsupported versions, malformed/missing data, negative coordinates, cache limits/invalidation and source preservation. `npm run test:terrain` uses synthetic terrain and an isolated profile for screenshots, selection/protection/3D integration, navigation and dimension switching. Add `-- --legacy-1.21.11` for the legacy fixture. Synthetic worlds are format fixtures, not Minecraft-playable saves.

Routine tests use generated fixtures. The opt-in `node scripts/smoke-terrain-copy.mjs /path/to/world` creates a bounded, byte-verified disposable snapshot, opens only that copy in an isolated app profile, and verifies source and copy hashes after map browsing. It never invokes copy/export transactions or claims gameplay validation. Existing regeneration and placement adapters, raw NBT capture, review digests and backup/confirmation requirements remain unchanged. Native Windows UI and Minecraft gameplay validation are separate acceptance work.
