# Streaming template benchmarks

Measured on 2026-10-15 using Node v24.19.0, macOS Darwin 25.6.0 arm64, Apple M5, 24 GiB memory. The complete machine-readable report, including exact digests, is [template-benchmark-results.json](template-benchmark-results.json).

```sh
node scripts/benchmark-templates.mjs --output template-benchmark-results.json
```

Each case runs sequentially in a fresh Node process. Completed cases are saved immediately; `complete: true` confirms the whole requested run finished. `--quick` runs small smoke fixtures. `--case sparse-disconnected` or `--case incompressible-over-64mib` runs one profile. `--recover FILE` verifies a retained `mixed-full-large` fixture without rewriting it; it deliberately reports no write measurement.

| Generated fixture | Chunks | Selected cells | Raw supporting records, bytes | Archive, bytes | Write + revalidation, s | Validated read, s | Peak RSS, MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Mixed full, small | 1,024 | 16,777,216 | 10,575,872 | 868,677 | 1.571 | 0.972 | 175.625 |
| Mixed full, large | 16,384 | 268,435,456 | 169,213,952 | 13,914,034 | 42.925 | 20.149 | 281.750 |
| Sparse disconnected | 4,096 | 2,097,152 | 42,303,488 | 3,659,487 | 23.274 | 2.523 | 268.422 |
| Incompressible unknown data | 80 | 327,680 | 72,229,600 | 72,096,720 | 1.101 | 0.139 | 108.297 |

The large full selection contains 268.4 million cells, including 211,550,208 intentional air cells and 56,885,248 non-air cells. It writes and revalidates at 6.254 million selected cells/s and reads with validation at 13.322 million cells/s. Increasing the full fixture's chunk and cell counts by **16×** increased peak RSS by **1.604×**, from 175.625 to 281.750 MiB, in separate processes using the same method. This is an observed allocator/GC high-water mark, not a promise of fixed process RSS for arbitrary record shapes.

The sparse fixture selects two separate 4×4×4 components per section, with selected chunks 1,024 blocks apart. Its bounding volume is **266,487,218,176 cells**, but only 2,097,152 cells are selected; gaps do not create stored chunks or selected air. The file still preserves the full source/supporting records for the chunks that contribute selected cells. Its 8,388,608 bytes of uncompressed mask bits are included in the compressed frames.

The final fixture carries a deterministic, incompressible 900,000-byte unknown NBT array in each terrain record. Its **72,096,720-byte (68.757 MiB)** archive exceeds the old 64 MiB total-file limit and passes all checks. The mixed building fixtures are deliberately regular floors, walls, windows, stairs with exact properties, water, and air; their compression ratio is not a prediction for every real build. `sourceRawBytes` measures raw NBT only; `fileBytes` measures the entire compressed archive, including masks and format overhead.

Write time includes generated chunk production, semantic validation, compression, fsync, full automatic rereading, and publication. Read time includes decompression, semantic validation, and an independent SHA-256 digest over every selection mask and all raw region/entity/POI bytes. Each case checks the header, counts, exact raw bytes, selected air and solids, and the complete file digest. Unknown fields include exact 64-bit integers and modified UTF-8 strings. No user world saves are read. The harness retains one generated chunk at a time and deletes its temporary archives.

These measure storage APIs, not UI responsiveness, rendering, world scanning, or transfer writes. Results are single runs and vary with host load. An earlier session lost its execution connection and original large-case timing; its published archive was independently verified before this complete fresh run. Every number in the table comes from the final complete standard run, without mixing recovery-only memory measurements into the comparison.
