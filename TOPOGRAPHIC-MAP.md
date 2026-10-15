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
