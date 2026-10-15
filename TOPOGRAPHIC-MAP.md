# Optional topographic map

Choose **View → 3D topographic** beside the terrain controls. The existing top-down map remains available. The view reuses decoded surface heights and material colors, raising each visible block column to its actual top elevation. It adds chunk grid lines, selection/protection outlines, rotation, zoom and picking against the rendered faces. Selection feeds the same protection and 3D-preview bounds as the flat map.

- Click a surface chunk or drag between chunks to select a rectangular area.
- Right-drag or choose Orbit to rotate. Shift-drag, middle-drag or choose Pan to move.
- Scroll or use +/− to zoom. Q/E rotate and arrow keys pan the focused canvas.
- Go accepts block coordinates. Fit selection recenters the view; Center world recenters its bounded window. North / reset tilt restores orientation.

This is a **surface representation**, not a block-volume viewer. Step faces connect known neighboring surface heights; they do not describe caves, interiors, hidden floors or the contents of buildings. Nether cavern, roof and cutaway modes use the existing surface rules. No export or format gate changes when the view changes.

Pending, unreadable, unsupported, absent and decoded empty areas have distinct labeled markers. These markers are annotations, not inferred elevations. Unknown columns are not filled with air or bridged with made-up terrain. Failed graphics initialization/context loss returns to the top-down view with an error message.

## Bounds and validation

The mesh covers at most an 11×11 chunk window (121 tiles), even for a large world. Pan or Go moves that window. GPU geometry outside it is disposed; no whole-world mesh is built. At most two chunks are rebuilt per animation frame. The worst-case mesh budget is 310,002 triangles including markers. An idle view does not continuously render. Coordinates are relative to a nearby origin to retain precision far from world spawn.

Both views share the existing asynchronous 16-chunk requests and 2,048 projected-tile cache. The renderer retains the 1 KiB projected color array per cached tile for mesh colors, not expanded NBT. Selection and protection plans remain outside the source save.

`tests/topography.test.js` verifies bounded windows, exact elevation, empty/unknown handling, cross-chunk steps and ray picking at negative coordinates. `scripts/smoke-topographic.mjs` runs native rendering, selection/protection integration, orbit/navigation, far-coordinate bounds, idle rendering, dimension switches and the return to top-down. The packaged smoke suite runs the same checks on the distributed Mac app. Native Windows runtime and Minecraft gameplay remain separate acceptance work.

## View scale and larger selections (0.5.8)

The side **View scale** slider is camera-only. **1:1** is the default and largest setting: a camera distance of 264 block units at a 45-degree field of view. It is a relative display reference, not one screen pixel per block or physical monitor scale. Smaller ratios move the camera back, down to 1:1,048,576 for very broad indexed extents. Geometry, world coordinates, selected chunks and export bounds never change. Scroll and +/− use the same bounded scale; Reset 1:1 restores the reference without clearing the selection. Fit selection frames the complete selection extent, including offscreen chunks.

The 121-chunk detail window is a rendering budget, not a selection limit. Select range accepts coordinates outside that window. Replace, Add and Remove modes support multi-chunk/disconnected ranges, and Select all selects every indexed chunk in the current dimension. Counts always include offscreen chunks. Selections survive panning, scale changes, view switches and dimension switches within the current open-world session. Clear/Replace, opening another world, or refreshing the world are explicit selection-reset operations. Session selections are not a saved template; saved protection plans remain separate.

Inside the detail window, selected chunk surfaces retain their highlights. A blue outline shows the full selection's rectangular bounds, which can include gaps that are not selected. This outline does not invent terrain outside the detail window. Use top-down for the larger terrain overview.

## Complete top-down overview and dimension cache (0.5.9)

Opening a world starts background coverage of **every saved chunk in the selected dimension**, regardless of the viewport. There is no 1,024- or 16,384-chunk total-coverage cap. The existing inspection limits (1,000,000 terrain chunks / 20,000 region files across stores) still apply. More than 1,024 visible chunks uses per-chunk average colors from actual decoded surface columns; zooming requests detailed projected tiles. Unknown, pending, incomplete, absent, unreadable, and unsupported records never become invented terrain. Whole overview coverage is not whole-world block loading or a gameplay validation.

A single worker processes at most 16 terrain chunks per request, or validates 32 cached overview regions. The main window remains responsive. Round-robin region work supplies early coverage and then finishes all indexed records, including offscreen chunks. Region-header inspection is reused in a 64-region LRU only for terrain, with file stamps checked before reuse and payload reads still verified. Existing export readers keep their defaults. Rendering updates only changed region images in a viewport-sized backing canvas.

Compact summaries use **5 bytes per indexed chunk**; retained projection states have an aggregate **16 MiB / 8-state** LRU. Full projected tiles share one **2,048-tile** renderer cache across dimensions/modes; the reader has a separate 2,048-tile LRU. Region bitmaps remain bounded to 128, detailed 3D geometry to 121 chunks. No raw NBT or whole-world mesh is retained. Other index, Electron, and GPU memory is additional and is measured in benchmark evidence.

Derived overview summaries persist under the active app profile's **terrain-cache** directory, never inside a source save. Atomic per-region files have a 64 KiB size guard and an overall 128 MiB / 32,768-file oldest-access eviction budget. Corrupt, truncated, mismatched or obsolete records are cache misses and are recomputed; cache I/O failure leaves decoding usable with a visible warning. The cache has no authority over export, protection, template or block data.

Cache identity includes the canonical source path, level.dat fingerprint, dimension/layout, view mode/height, adapter options, and projection schema. Source validation includes region size, mtime, ctime and inode, plus all indexed external payload stamps. A changed region requires Refresh to obtain a new chunk index; a changed external payload invalidates that region's summaries. Metadata changes conservatively invalidate the world's previous cache. Open, Refresh and returning to a dimension validate storage before displaying cached ready data. This is not a live filesystem watcher; close Minecraft before inspection and Refresh after changes.

Overworld → Nether → Overworld restores each dimension's surface mode, cutaway height, 2D pan/zoom, 3D camera, and session selection. Ready summaries and bounded projected tiles are reused after validation. Inactive dimensions stop scheduling further reads; a request already running may finish into its originating cache, never into another dimension. A later activation cannot be advanced by an earlier response. Disk summaries survive app restart; camera and unsaved selection remain session state. Evicted details are loaded again on demand.

`scripts/smoke-terrain-cache.mjs` creates a verified disposable copy and isolated profile, runs cold/warm opens, dimension switches during reads, camera/selection retention and app restart, samples process working-set memory, records cache size/screenshots, and rechecks source hashes. `tests/terrain-cache.test.js` covers invalidation, corrupt cache, quota eviction, one-million-chunk queue coverage and deterministic cancellation races. Native Windows execution remains separate acceptance work.

## Independent operation limits

Map selection can cover the inspected chunk index (world inspection itself is bounded to 1,000,000 chunks and 20,000 region files). Protection plans remain limited to 100,000 chunks. Reset review remains limited to 10,000 chunks plus the 256 MiB content-inspection budget and all preservation gates. Current build/template volume capture remains bounded to 128 × 384 × 128 extent and 1,048,576 total blocks; archives remain 64 MiB compressed / 192 MiB expanded. Selecting a larger area does not silently truncate it to fit those operations: the operation must reject it or the user must narrow its bounds. Scalable template storage and volumetric interior selection are a separate phase.
