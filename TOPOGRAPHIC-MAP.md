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

## Automatic top-down overview

Opening a world and Fit world start coarse loading without any wheel/pan input. More than 1,024 visible chunks uses per-chunk average colors derived from decoded surface tiles. Batches remain 16 chunks, asynchronously scheduled; full projected tiles remain capped at 2,048 and coarse summaries at 16,384. World/dimension/height-mode changes invalidate caches and stale responses. Changing the view redirects the loading queue while retaining useful same-world cached colors.

At most 16,384 visible chunks are sampled per overview. Larger footprints use a deterministic spread sample, with total/sample counts disclosed; unsampled chunks stay explicitly gray. Incomplete generation, unreadable and unsupported records remain marked, never treated as empty terrain. Zooming automatically loads individual block detail. A color summary does not certify the contents of a chunk or expand export permissions.

## Independent operation limits

Map selection can cover the inspected chunk index (world inspection itself is bounded to 1,000,000 chunks and 20,000 region files). Protection plans remain limited to 100,000 chunks. Reset review remains limited to 10,000 chunks plus the 256 MiB content-inspection budget and all preservation gates. Current build/template volume capture remains bounded to 128 × 384 × 128 extent and 1,048,576 total blocks; archives remain 64 MiB compressed / 192 MiB expanded. Selecting a larger area does not silently truncate it to fit those operations: the operation must reject it or the user must narrow its bounds. Scalable template storage and volumetric interior selection are a separate phase.
