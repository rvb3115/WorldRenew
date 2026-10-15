# Large-world loading and selected-area previews — 0.5.11-test.1

The previous overview queue rotated one chunk per region. Worlds with more regions than the bounded header cache repeatedly parsed the same headers and rewrote small cache updates. The new queue loads up to 16 actual samples per region in its coverage pass, then finishes each region in contiguous batches. Uninspected neighboring chunks remain pending; samples never fill them with guessed colors.

Visible details and their cache validation take priority. **Pause overview** stops background work at the next bounded batch boundary while visible detail still loads. **Go** and zoom can therefore inspect a chosen area before a large world finishes. Completed batches persist outside the source world and resume on reopening. The footer separately reports ready, pending, incomplete generation, unreadable and unsupported chunks. No parser failure becomes empty terrain.

Block decoding still validates every signed NBT long and palette index. Exact uint32 extraction replaces per-block BigInt shifts; validated uniform sections skip unnecessary surface searches. Missing or malformed supplied sections are still rejected. Scalar projection comparisons preserve identical heights, palette order and colors. The source format and export/placement safety gates are unchanged.

Switching explicitly to the topographic view frames the current selection and resets its orientation. Status annotation planes stay below the minimum supported terrain height so absent/error tiles cannot obscure real lower surfaces. The dense block preview frames the exact requested rectangle, including negative coordinates and its dimension height, instead of centering only on known solids. Editing the request clears old geometry immediately. Responses for an old world, dimension, bounds or closed dialog are ignored. Disconnected selections disclose intervening gaps; selections exceeding the existing dense preview limit are rejected without substituting another area. Topographic detail remains a bounded window, with selected chunks outside it reported in the UI.

## Measured evidence

All measurements below use generated Java-format fixtures; they are not gameplay certification or timings of a user's save.

| Scenario | Result |
| --- | --- |
| 2,560 chunks / 80 regions, frozen 0.5.10 versus optimized progressive load | 7.347 s → 1.901 s; header reads 2,560 → 160; cache writes 2,560 → 240; identical summary hash |
| 247,895 distinct chunks / 243 regions | Completed across an interrupted run and cache resume; all chunks ready, no pending chunks; 4,140,116-byte disk cache |
| Complete large cache reload in benchmark runner | 127.6 ms, zero terrain decodes |
| Native hidden UI opening/indexing/validating/rendering the complete large cache | 5.67 s, zero terrain decodes; 246 generated fixture files unchanged |
| Native pause → jump to uncached visible area | Detail loaded in 86.5 ms while background remained paused; partial-cache resume and fully cached reopen passed; 83 generated fixture files unchanged |

The interrupted large run included host stalls, so it is **not a clean full cold-load timing**. Sparse overview coverage still requires actual reads; a large cold world is not instantaneous. Warm UI opening includes indexing and cache validation, which the smaller cache-runner timing excludes. Memory and timings depend on world layout and hardware.

## Reproduction and boundaries

`scripts/benchmark-large-overview.mjs` creates or resumes test-owned fixtures under `work/`, records source hashes and compares deterministic summary hashes. `scripts/smoke-large-overview.mjs` checks pause, visible priority, resume and warm reopening. `scripts/smoke-overview-scale.mjs` verifies an existing generated large fixture and cache through the native UI. `scripts/smoke-preview-location.mjs` covers displaced selection, negative coordinates, dimension switching, disconnected/oversized bounds and a delayed stale response. Each UI check uses an isolated profile and hashes its generated source files.

Run `node qa/run.mjs --full` for the engine and regression suite. `WORLDRENEW_BACKGROUND_TEST=1 node scripts/smoke-packaged.mjs` tests the actual distributed Mac ZIP after building it, including selected-area preview regression. Run matching native checks on Windows before claiming Windows execution parity. Both packages use the same source; Windows native installer/runtime and Minecraft gameplay checks remain pending.

Mac development and extracted smoke-test bundles now live in hidden `.noindex` directories; packaged tests unregister only their own extracted app. The local install helper refuses to replace a running canonical app and keeps the previous bundle in a hidden `.noindex` backup directory. It does not alter the normal app profile. These changes do not publish a release or implement automatic updates.
