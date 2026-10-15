# Sparse portable template core

This additive core is independent of the renderer, desktop IPC, and world writer. Existing schema-1 APIs and their preview limits stay compatible. New calls can capture, store, import, inspect and export large schema-2 `.wrbuild` files without allocating a full bounding-box voxel array. No destination-world write compatibility is added.

## Integration

```js
import { createSparseSelection } from './engine/sparse-selection.js';
import { captureTemplateStream } from './engine/template-capture.js';
import { importTemplateStream, openTemplateStream } from './engine/template-stream-library.js';

const selection = createSparseSelection(firstCorner, oppositeCorner);
selection.removeBlock(x, y, z);       // exclude this cell, even if it contains air
selection.addBlock(otherX, otherY, otherZ); // disconnected additions belong to this template
selection.addBox(inclusiveBounds);
selection.removeBox(inclusiveBounds);

// Run synchronous file/NBT operations in a worker, using an inspected, closed world.
const options = {
  worlds: [sourceWorld.root],         // also supply any open destination world roots
  shouldCancel: () => Atomics.load(cancelFlag, 0) !== 0,
  onProgress: event => reportProgress(event),
};
const captured = captureTemplateStream(newExternalFilename, sourceWorld,
  dimensionKey, selection, options);
const imported = importTemplateStream(libraryDirectory, captured.file, options);
const opened = openTemplateStream(libraryDirectory, imported.id, options);
for (const event of opened.iterate()) {
  if (event.type === 'chunk') consumeOneChunk(event.chunk);
}
```

A selection is membership, not terrain: a selected known air cell has its exact `air`, `cave_air` or `void_air` state. An excluded cell has no selected bit. Missing terrain or missing block sections fail capture/validation; they never become air. A one-block selection can therefore contain a block plus another disconnected piece arbitrarily far away without scanning the empty gap.

`SparseSelection` supports `contains`, `bounds`, `blockCount` (BigInt), `boxCount`, `toJSON`, `fromJSON`/`deserializeSparseSelection`, `iterateChunks`, and `iterateSections`. Bounds are inclusive and each coordinate is within ±30,000,000. Two initial corners may be supplied in any order. Nonoverlapping cuboids track edits; their count, not the selected volume, determines selection memory. Iterators snapshot the selection at creation. Chunks are ordered by Z then X; sections are lazy and ordered by section Y. Each section has `{y, mask, selectedCount}`; `mask` is 512 bytes, least-significant bit first, indexed `localY * 256 + localZ * 16 + localX`. Serialize the selection JSON separately when an editable selection needs persistence; library templates persist the resulting membership masks.

New library calls are `saveTemplateStream(directory, name, header, chunks, options)`, `importTemplateStream(directory, source, options)`, `openTemplateStream(directory, id, options)`, `exportTemplateStream(source, destination, options)`, and `listTemplatesStream(directory, options)`. Names and duplicate numbering follow the existing library convention. Imports/exports copy exact bytes in 1 MiB batches. Open returns `{id,file,header,summary,digest,iterate}` and validates before returning. `.iterate()` rechecks file identity/digest; callers must consume through the end before accepting that iteration as verified. Enumeration only returns file metadata and marks a 10,000-entry directory scan as truncated.

The low-level API is `writeTemplateStream(file, header, chunksIterable, options)`, `iterateTemplate(file, options)` and `validateTemplateStream(file, options)`. The iterator emits header, chunk and end events. A chunk is `{x,z,sections:[{y,mask}],records:{region:Buffer,entities:Buffer|null,poi:Buffer|null}}`. `selectedTemplateBlocks(chunk)` lazily yields coordinates and normalized exact states for selected bits; raw supporting records retain all original tag types, unknown fields, biome palettes, entities/passengers, ticks and surrounding chunk content. Supporting records are preserved evidence; they do not authorize transferring all their contents.

Summary counters `selectedBlocks`, `air`, `nonAir`, `fluids` and `rawBytes` are decimal strings; `chunks` is a number. File `digest` is SHA-256 of every serialized byte. A fully consumed reader checks frame checksums, counts and the final content digest. Header-only or partially consumed reads have not validated the complete template.

Both `AbortSignal` and `shouldCancel()` are supported by storage/capture/library operations. Synchronous worker loops should use a shared-memory cancellation predicate; posting a message to the same blocked event loop cannot interrupt it. Checks occur between bounded sections/chunks/copy batches; synchronous zlib/NBT operations finish their current bounded frame before cancellation. Selection-only iterators accept `signal`. Progress callbacks are synchronous, and throwing cancels the operation. Temporary files/journals are cleaned on failure. Capture rechecks source file identities, nanosecond timestamps, optional absent stores, external chunk payloads and metadata using a disk journal, including immediately before publication. Keep source worlds closed: stat checks detect changes but are not a filesystem snapshot or lock.

## Schema 2 wire format

All integers below are unsigned big-endian. The format is self-contained and does not depend on an index, source path, registry download or destination world.

1. Nine-byte ASCII `WRBUILD2\n`, four-byte header JSON length, UTF-8 header JSON.
2. Zero or more chunk frames: byte `1`, four-byte zlib payload length, four-byte expanded length, 32-byte SHA-256 of expanded bytes, then one zlib stream. At least one selected chunk is required.
3. Footer: byte `0`, four-byte footer JSON length, UTF-8 footer JSON. No trailing bytes are allowed.

Header: `{format:'WorldRenew.build',schema:2,createdAt,source:{name,version,dataVersion,dimensionId,dimensionKey,bounds,configuration?},...extensions}`. Capture retains the existing stable 26.2/26.3 provenance gate; this format work does not expand game-version write support.

Expanded chunk: four-byte manifest JSON length, manifest JSON, partial masks in section order, then raw uncompressed NBT records in `region,entities,poi` order. The manifest carries `x,z,sections:[{y,mask:'full'|'bits',...extensions}],records:{region:length,entities:length|null,poi:length|null},...extensions`. Full 4096-bit masks cost no separate bytes; partial masks cost 512 bytes before compression. Native NBT palettes and padded packed state indices are retained exactly, avoiding a duplicated dense palette/voxel representation. Chunk JSON extensions, section extensions, opaque record-manifest JSON fields and header extensions survive round trips. Only the three named raw record stores have binary payload semantics. Legacy record-wrapper extensions are exposed as `recordMetadata` during v1 conversion.

Footer contains summary counts, expanded frame byte count as a decimal string, and `contentDigest` (SHA-256 of every byte preceding the footer byte). Strict Z/X and section-Y ordering rejects duplicate frames without an all-build index in memory. Frame validation rejects inconsistent record positions/versions, incomplete terrain, invalid selected palettes, empty/invalid masks, cells outside declared bounds, trailing compressed data, truncation and checksum/count mismatches.

## Resource limits and compatibility

There is no small total template block, chunk, expanded-byte or file-byte cap for v2. Optional per-operation `maxChunks`, `maxSelectedBlocks`, `maxExpandedBytes`, and reader `maxFileBytes` let callers enforce their own budgets. Runtime is proportional to selected chunks/sections and preserved records. Callers must consume and release batches; collecting the iterator into an array naturally removes the bounded-memory benefit.

Safety bounds apply per unit: 1 MiB header/manifest/footer JSON; 32 MiB per raw supporting record; 100 MiB expanded and 101 MiB compressed per chunk frame; up to 4096 selected sections per chunk. Existing NBT limits apply per record (depth 64 and 1,000,000 nodes/collection length). Expansion is checked before decompression; the declared frame length also caps zlib output, including highly compressible inputs. Highly repetitive records are allowed without a compression-ratio heuristic. Peak memory is a bounded number of frame buffers plus parsed record objects, not a guarantee of a tiny constant number of bytes.

Selection defaults limit edit complexity to 100,000 cuboids, 10,000,000 edit comparisons/operations, and 64 MiB serialized selection data. These configurable limits constrain fragmentation/adversarial metadata, not build size. Edits fail atomically.

The streaming reader accepts v1 files through the unchanged legacy validator. Legacy files retain their old dense decoder and size limits; importing/exporting them does not transcode or discard unknown bytes. To transcode explicitly, pass the streaming header and yielded chunks to the v2 writer. Existing `readBuildFile`, `openTemplate` and placement APIs remain v1-only and must not receive v2 files. The parent UI workstream needs to route template storage to the new API and build its own bounded preview adapter; never silently flatten sparse masks for the existing destination writer.

## Validation

Validation on this worktree: `node --test tests/*.test.js` passed all 257 tests (4.88 seconds). The only pre-existing external runtime test dependency, `three@0.186.1`, was copied into this worktree’s ignored `node_modules` from the installed package; no dependency or installation files changed. Run that command to repeat the repository tests. New focused tests cover generated sparse membership, legacy compatibility, exact raw/unknown records, malformed frames and decompression limits, cancellation, path protection, copy mutation and source mutation. `node scripts/benchmark-templates.mjs` runs generated-only measured scenarios in separate processes; see `TEMPLATE-BENCHMARKS.md` for recorded results and limitations. No user world save is read by these tests or benchmarks.
