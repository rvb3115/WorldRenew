# Streaming v2 template placement

This isolated follow-up builds on the sparse selection/archive core in `b66d540`
and `dc86561`. It adds only new core helpers, generated tests and a benchmark.
There are no UI, loading/cache, installation, release or main-worker changes.

## Integration

Import `previewTemplatePlacement` and `createTemplatePlacedCopy` from
`engine/template-placement.js`. Route schema-2/`WRBUILD2\n` archives here and retain
the existing schema-1 `previewBuildFile`/`createPlacedCopy` route. The adapter
explicitly rejects legacy archives instead of silently widening the old writer.
`iterateTemplate` remains the common version-aware archive reader.

```js
import { inspectWorld } from './engine/world.js';
import {
  previewTemplatePlacement,
  createTemplatePlacedCopy,
} from './engine/template-placement.js';

const destination = inspectWorld(destinationDirectory);
const dimensionKey = destination.dimensions.find(d =>
  d.id === 'minecraft:overworld').key;
// Coordinates of the translated selection bounding box minimum, not a chunk.
const anchor = { x: 160, y: 64, z: -32 };
const settings = {
  airMode: 'include', // or 'skip': all three captured air variants stay untouched
  protection: [], // [{ dimension: dimensionKey, x: chunkX, z: chunkZ }]
  onProgress: event => reportProgress(event),
  shouldCancel: () => cancellationRequested,
  // signal: AbortSignal, worlds: [otherWorldDirectory]
};
const review = previewTemplatePlacement(
  templateFile, destination, dimensionKey, anchor, settings);
if (!review.copyEligible) throw new Error(review.blockers.join(' '));
// Present the concrete review through the owning application's existing flow.
const output = createTemplatePlacedCopy(
  templateFile, destination, dimensionKey, anchor, outputParentDirectory,
  { ...settings, confirmedClosed: true, reviewDigest: review.reviewDigest });
// output.directory, output.world, output.backup, output.report
```

Both APIs are synchronous and belong in the application's existing worker path.
The source world is not required or accessed. The destination must be freshly
inspected and closed. The review binds archive bytes, source metadata, destination
configuration, exact touched/border records, anchor, air mode and protection.
Export requires the fresh matching digest. Relevant total counts are decimal
strings; consumers should use `BigInt` instead of rounding large values.

A blocked preview returns `copyEligible: false`, `blockers`, and a null digest.
Cancellation throws `TEMPLATE_CANCELLED`; export also throws for failed gates,
stale evidence or verification errors. Progress phases include `Preparing template
placement`, `Validating placement`, the existing verified-copy phases, `Placing
template region`, `Preparing template region`, and `Verifying placed files`.

## Semantics and safety

- Exact sparse membership survives integer translation across negative chunk,
  section and region boundaries. Disconnected components do not fill the gap.
- `include` preserves the selected source air variant exactly; `skip` leaves its
  destination cell unchanged. Excluded cells stay unchanged in both modes.
  Selected skipped-air cells still undergo known-terrain and attachment checks.
- The existing Java **26.2 / DataVersion 4903**, matching vanilla dimension and
  ordinary supported building-block gates remain. Special blocks, selected
  entities/block entities/ticks/POI, unavailable terrain, protected chunks and
  pending upgrade/retrogen/blending/postprocessing data fail clearly. A known,
  compatible one-chunk lighting border is required around each selected chunk.
  Missing terrain between disconnected components is irrelevant.
- Only a fresh verified working copy is changed. A verified backup is retained.
  Full file hashes protect original worlds, backup, player files and unaffected
  files. Chunk verification checks every rewritten section cell plus exact typed
  palettes and unrelated metadata; region verification checks untouched allocated
  records, timestamps and padding. Modified chunks invalidate heightmaps, while
  the entire lighting border clears cached light and marks lighting unfinished.
- Palette entries with unknown extensions are retained exactly when unaffected.
  A selected source entry, or a replaced destination entry, whose extended data
  cannot be safely transferred is blocked. Unknown block-state containers or
  compact palette encodings are not normalized away. Adding states past 4096
  palette entries blocks instead of discarding unused/extended entries.
- Private source records/masks, patch lists, expected rewrites and output hashes
  carry integrity checks. Missing/replayed patch contributions, modified scratch
  evidence and prepared-region mutation are rejected. The final verification
  has no user callbacks before atomic publication.
- Failure/cancellation removes the owned working copy and plan. If backup
  creation already completed, a `.WorldRenew-placement-*.partial` folder retains
  only the verified backup and failed-operation journal; no final result is
  published. Output reports `gameLoadTested: false`.

## Memory, disk and compatibility limits

No total selected-block, source-chunk, bounding-volume or archive-size cap is
introduced. Source frames are consumed sequentially; translation produces at
most four destination chunks per source chunk. Destination rewrites retain one
chunk and consume source contributions lazily. A region plan holds at most 1024
chunk entries, and untouched region allocations stream in 1 MiB buffers.

The plan is disk-backed. Preview needs temporary disk proportional to selected
source raw records and masks, plus chunk/region journals. Export also needs the
existing full backup and working-world copies. It does not load the entire
selection, all raw chunks, or a region file into memory.

Existing safety bounds remain: 32 MiB decompressed NBT records, 256 MiB per region,
255 sectors per replacement record, and no replacement of external terrain
records. Untouched external records are preserved. Current vanilla heights and
coordinate bounds still apply. Source attachments stored outside their owning
source chunk are conservatively refused when safe ownership cannot be proven.

The inherited whole-world copy/inventory stage is **not constant-memory**: it
retains file manifests and three inventories, with the existing 200,000-entry
and depth-64 filesystem bounds. This adapter caps manifest parsing at 128 MiB.
Cancellation is checked between bounded chunk/region/hash work. The final silent
inventory and publication checks are synchronous and may delay cancellation. Inherited copy
and world-inspection work may finish a file/inspection step before cancellation.
These limits constrain storage validation, rather than imposing a tiny template
size cap. Raising or redesigning them is a separate safety change.

## Validation and measured benchmark

The complete suite passed **326 tests** (67 new placement tests). Coverage
includes air modes, negative translation, offline source worlds, selected
attachments, unknown terrain, protection, stale reviews, cancellation, exact
preservation, and scratch/output integrity faults.

Run the generated regression suite and standalone benchmark:

```sh
node --test tests/*.test.js
node scripts/benchmark-template-placement.mjs --output template-placement-benchmark-results.json
```

The measured fixture has a full-height 4×3-chunk component, one excluded chest
with an inventory, and one disconnected cell 512 blocks away. The excluded cell
and added cell balance to **1,179,648 selected cells**. Only 39 required destination
chunks exist; the gap is absent. Verification independently checks every selected
cell and **2,654,208 excluded cells**, exact inventory/player/opaque NBT, captured
raw records, and original/backup hashes. It uses generated worlds only.

Measured on this Mac (Apple M5, 24 GiB, Node v24.19.0), in a fresh process without
forced garbage collection:

| Metric | Result |
|---|---:|
| Selected cells | 1,179,648 |
| Archive bytes | 17,461 |
| Capture plus validation | 0.153 s |
| Placement preview | 2.418 s |
| Complete verified export | 5.474 s |
| Independent exhaustive verification | 0.482 s |
| OS peak process RSS | 299.156 MiB |

Raw measurements and methodology are in
`template-placement-benchmark-results.json`. The fixture's regular geometry
compresses particularly well; its archive ratio is not a prediction for every
build. Export timing includes a fresh preview, both verified copies, repeated
preflight, region preparation, complete verification and publication. Peak RSS
covers fixture generation through independent verification. This is core
validation, with no Minecraft game-load or UI certification.
