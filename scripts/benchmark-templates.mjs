#!/usr/bin/env node
/** Generated fixtures only. Runs each case in its own process, sequentially. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { writeTemplateStream, iterateTemplate } from '../engine/template-stream.js';
import { nbt } from '../tests/fixtures.js';
import { sectionFixture, state } from '../tests/transfer-fixtures.js';

const MiB = 1024 ** 2;
const fullCases = [
  { name: 'mixed-full-small', chunks: 1024, sectionCount: 4, stride: 1, sparse: false, unknownBytes: 0 },
  { name: 'mixed-full-large', chunks: 16384, sectionCount: 4, stride: 1, sparse: false, unknownBytes: 0 },
  { name: 'sparse-disconnected', chunks: 4096, sectionCount: 4, stride: 64, sparse: true, unknownBytes: 0 },
  { name: 'incompressible-over-64mib', chunks: 80, sectionCount: 1, stride: 1, sparse: false, unknownBytes: 900000 },
];
const round = value => Math.round(value * 1000) / 1000;

function noise(length) {
  const bytes = Buffer.alloc(length);
  let seed = 0x6d2b79f5;
  for (let i = 0; i < length; i++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    bytes[i] = seed >>> 24;
  }
  return bytes;
}

// Floors, walls, windows, stairs with exact properties, water, and intentional air.
// Several materials and orientations vary by section; the native packed palette
// is carried unchanged in raw NBT, along with unknown future fields.
function block(x, y, z) {
  const ly = y & 15, level = y >> 4;
  if (ly === 0) return state(['stone_bricks', 'oak_planks', 'polished_andesite', 'deepslate_tiles'][level % 4]);
  if (ly === 1 && z === 8 && x >= 6 && x <= 9) return state('water', { level: '0' });
  if (ly > 10) return state('air');
  if (x === 0 || x === 15 || z === 0 || z === 15) {
    if (ly >= 3 && ly <= 6 && ((x + z) & 3) !== 0) return state('glass');
    return state(ly === 10 ? 'dark_oak_planks' : ['bricks', 'sandstone', 'quartz_bricks', 'mud_bricks'][level % 4]);
  }
  if (x >= 3 && x <= 6 && z === 4 && ly === x - 2) return state('oak_stairs', {
    facing: ['north', 'east', 'south', 'west'][level % 4], half: 'bottom', shape: 'straight', waterlogged: 'false',
  });
  if (ly === 1 && x % 5 === 0 && z % 5 === 0) return state('lantern', { hanging: 'false', waterlogged: 'false' });
  return state('air');
}

function selectionMask(sparse) {
  if (!sparse) return Buffer.alloc(512, 255);
  const mask = Buffer.alloc(512);
  // Two separated 4 × 4 × 4 components in each selected section.
  for (const start of [1, 11]) for (let y = start; y < start + 4; y++) {
    for (let z = start; z < start + 4; z++) for (let x = start; x < start + 4; x++) {
      const i = y * 256 + z * 16 + x;
      mask[i >> 3] |= 1 << (i & 7);
    }
  }
  return mask;
}

function recordBlueprint(config) {
  const sectionTags = Array.from({ length: config.sectionCount }, (_, y) => sectionFixture(y, block));
  const raw = nbt({
    DataVersion: [3, 5023], xPos: [3, 0], zPos: [3, 0], Status: [8, 'minecraft:full'],
    sections: [9, { type: 10, values: sectionTags }],
    block_entities: [9, { type: 10, values: [] }], block_ticks: [9, { type: 10, values: [] }], fluid_ticks: [9, { type: 10, values: [] }],
    FutureUnknown: [10, { exactLong: [4, -9223372036854775807n], label: [8, 'future\0data 🌲'], payload: [7, noise(config.unknownBytes)] }],
  });
  const offset = name => {
    const needle = Buffer.concat([Buffer.from([3, 0, name.length]), Buffer.from(name)]);
    const at = raw.indexOf(needle);
    assert.notEqual(at, -1);
    return at + needle.length;
  };
  return { raw, xOffset: offset('xPos'), zOffset: offset('zPos') };
}

// Hash lengths as well as contents to make this an unambiguous byte-for-byte
// check of all supporting records and masks, independent of frame checksums.
function hashChunk(hash, chunk) {
  hash.update(JSON.stringify([chunk.x, chunk.z, chunk.sections.map(s => s.y)]));
  for (const section of chunk.sections) hash.update(section.mask);
  for (const store of ['region', 'entities', 'poi']) {
    const bytes = chunk.records[store];
    hash.update(`${store}:${bytes === null ? 'null' : bytes.length}:`);
    if (bytes !== null) hash.update(bytes);
  }
}

function runCase(config, recoveryFile = null) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worldrenew-template-bench-'));
  try {
    const file = recoveryFile ? path.resolve(recoveryFile) : path.join(directory, 'generated.wrbuild');
    const width = Math.ceil(Math.sqrt(config.chunks));
    const rows = Math.ceil(config.chunks / width);
    const bounds = { minX: 0, minY: 0, minZ: 0, maxX: ((width - 1) * config.stride + 1) * 16 - 1, maxY: config.sectionCount * 16 - 1, maxZ: ((rows - 1) * config.stride + 1) * 16 - 1 };
    const header = {
      format: 'WorldRenew.build', schema: 2,
      source: { name: 'Generated benchmark fixture', version: '26.3', dataVersion: 5023, dimensionId: 'minecraft:overworld', dimensionKey: 'generated:overworld', bounds },
      benchmark: { fixture: config.name, seed: '0x6d2b79f5', unknownHeader: 'preserve me' },
    };
    const blueprint = recordBlueprint(config), mask = selectionMask(config.sparse);
    const poi = nbt({ DataVersion: [3, 5023], Sections: [10, {}], UnknownSupporting: [4, 9223372036854775807n] });
    const sourceHash = createHash('sha256');
    const startRssBytes = process.memoryUsage().rss;
    let sourceRawBytes = 0, progressCalls = 0, sampledPeakRssBytes = startRssBytes;
    const progress = () => {
      if (++progressCalls % 128 === 0) sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage().rss);
    };
    function* chunks() {
      for (let i = 0; i < config.chunks; i++) {
        const x = (i % width) * config.stride, z = Math.floor(i / width) * config.stride;
        const region = Buffer.from(blueprint.raw);
        region.writeInt32BE(x, blueprint.xOffset); region.writeInt32BE(z, blueprint.zOffset);
        const entities = nbt({ DataVersion: [3, 5023], Position: [11, [x, z]], Entities: [9, { type: 10, values: [] }], UnknownSupporting: [8, 'exact entity sidecar'] });
        const chunk = { x, z, sections: Array.from({ length: config.sectionCount }, (_, y) => ({ y, mask })), records: { region, entities, poi } };
        sourceRawBytes += region.length + entities.length + poi.length;
        hashChunk(sourceHash, chunk);
        yield chunk;
      }
    }
    let written, writeSeconds = null;
    if (recoveryFile) {
      // Reconstruct the deterministic source digest without rewriting the saved
      // archive. The generator retains one chunk and a fixed blueprint only.
      for (const chunk of chunks()) void chunk;
    } else {
      const writeStarted = performance.now();
      written = writeTemplateStream(file, header, chunks(), { onProgress: progress });
      writeSeconds = (performance.now() - writeStarted) / 1000;
    }
    const expectedRawDigest = sourceHash.digest('hex');
    const readHash = createHash('sha256');
    const readStarted = performance.now();
    let readChunks = 0, ending;
    for (const event of iterateTemplate(file, { onProgress: progress })) {
      if (event.type === 'header') assert.deepEqual(event.header, header);
      if (event.type === 'chunk') { readChunks++; hashChunk(readHash, event.chunk); }
      if (event.type === 'end') ending = event;
    }
    const readSeconds = (performance.now() - readStarted) / 1000;
    const expectedSelectedBlocks = BigInt(config.chunks) * BigInt(config.sectionCount) * BigInt(config.sparse ? 128 : 4096);
    assert.equal(readChunks, config.chunks);
    assert.equal(ending.summary.selectedBlocks, expectedSelectedBlocks.toString());
    assert.equal(ending.summary.rawBytes, String(sourceRawBytes));
    if (written) {
      assert.equal(ending.digest, written.digest);
      assert.deepEqual(ending.summary, written.summary);
    }
    assert.equal(readHash.digest('hex'), expectedRawDigest);
    assert(BigInt(ending.summary.air) > 0n, 'Fixture must exercise selected intentional air');
    assert(BigInt(ending.summary.nonAir) > 0n, 'Fixture must exercise selected solids');
    const fileBytes = fs.statSync(file).size;
    if (config.name === 'incompressible-over-64mib' && config.chunks === 80) assert(fileBytes > 64 * MiB, 'Must exceed the legacy 64 MiB file cap');
    const boundingBlocks = BigInt(bounds.maxX + 1) * BigInt(bounds.maxY + 1) * BigInt(bounds.maxZ + 1);
    return {
      ...config, operation: recoveryFile ? 'read-recovery' : 'write-and-read', selectedBlocks: expectedSelectedBlocks.toString(), boundingBlocks: boundingBlocks.toString(),
      selectedAir: ending.summary.air, sourceRawBytes, maskBytesBeforeEncoding: config.chunks * config.sectionCount * 512,
      fileBytes, fileMiB: round(fileBytes / MiB), rawToFileRatio: round(sourceRawBytes / fileBytes),
      writeAndRevalidateSeconds: writeSeconds === null ? null : round(writeSeconds), validatedReadSeconds: round(readSeconds),
      writeSelectedMillionBlocksPerSecond: writeSeconds === null ? null : round(Number(expectedSelectedBlocks) / writeSeconds / 1e6),
      readSelectedMillionBlocksPerSecond: round(Number(expectedSelectedBlocks) / readSeconds / 1e6),
      writeRawMiBPerSecond: writeSeconds === null ? null : round(sourceRawBytes / MiB / writeSeconds), readRawMiBPerSecond: round(sourceRawBytes / MiB / readSeconds),
      startRssMiB: round(startRssBytes / MiB), sampledPeakRssMiB: round(sampledPeakRssBytes / MiB),
      peakRssMiB: round(process.resourceUsage().maxRSS / 1024),
      digest: ending.digest, rawRecordsAndMasksDigest: expectedRawDigest, progressCalls,
      verified: { header: true, chunkCount: true, selectedCount: true, supportingRecordBytes: true, maskBytes: true, fileDigest: true },
    };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

const args = process.argv.slice(2);
if (args[0] === '--child') {
  process.stdout.write(`${JSON.stringify(runCase(JSON.parse(args[1]), args[2] || null))}\n`);
} else {
  let quick = false, output = null, only = null, recoveryFile = null;
  const usage = () => { throw new Error('Usage: node scripts/benchmark-templates.mjs [--quick] [--case NAME] [--output FILE] [--recover LARGE_FIXTURE_FILE]'); };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--quick') quick = true;
    else if (args[i] === '--output') { output = args[++i]; if (!output || output.startsWith('--')) usage(); }
    else if (args[i] === '--case') { only = args[++i]; if (!fullCases.some(c => c.name === only)) usage(); }
    else if (args[i] === '--recover') { recoveryFile = args[++i]; if (!recoveryFile || recoveryFile.startsWith('--')) usage(); }
    else usage();
  }
  if (recoveryFile) {
    if (quick || (only && only !== 'mixed-full-large')) usage();
    only = 'mixed-full-large';
  }
  const cases = fullCases.filter(c => !only || c.name === only).map(c => quick ? { ...c, chunks: c.name === 'incompressible-over-64mib' ? 2 : c.chunks / 64 } : c);
  const results = [];
  const environment = { node: process.version, platform: process.platform, arch: process.arch, release: os.release(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemoryGiB: round(os.totalmem() / 1024 ** 3) };
  const report = complete => {
    const small = results.find(r => r.name === 'mixed-full-small'), large = results.find(r => r.name === 'mixed-full-large');
    return {
      command: ['node', 'scripts/benchmark-templates.mjs', ...args].join(' '), timestamp: new Date().toISOString(), quick, complete, environment,
      methodology: 'Generated fixtures only; sequential fresh child per case; no user saves; one raw chunk at a time. Write includes generation, validation, compression, fsync, complete automatic reread and publication. Read includes decompression, semantic validation, and an independent digest of all record/mask bytes. OS maxRSS includes the entire child and GC high water, sampled RSS is supplementary. Temporary archives are deleted after each case. No forced GC. Recovery reads preserve the supplied archive and reconstruct the source byte digest first; no write measurement is reported. Recovery and write-and-read RSS are different methodologies.',
      memoryScaling: small && large && small.operation === large.operation ? { chunkRatio: round(large.chunks / small.chunks), selectedBlockRatio: round(Number(large.selectedBlocks) / Number(small.selectedBlocks)), peakRssRatio: round(large.peakRssMiB / small.peakRssMiB), peakRssDeltaMiB: round(large.peakRssMiB - small.peakRssMiB) } : null,
      results,
    };
  };
  const save = complete => {
    const json = `${JSON.stringify(report(complete), null, 2)}\n`;
    if (output) fs.writeFileSync(path.resolve(output), json);
    return json;
  };
  for (const config of cases) {
    process.stderr.write(`Benchmarking ${config.name}: ${config.chunks.toLocaleString()} chunks in a fresh process…\n`);
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', JSON.stringify(config), recoveryFile || ''], { encoding: 'utf8', timeout: 300000, maxBuffer: MiB });
    if (child.error || child.status !== 0) throw new Error(`${config.name} failed: ${child.error?.message ?? child.stderr}`);
    const result = JSON.parse(child.stdout); results.push(result);
    save(false);
    process.stderr.write(`  ${result.selectedBlocks} selected blocks; ${result.fileMiB} MiB; write+verify ${result.writeAndRevalidateSeconds}s; read ${result.validatedReadSeconds}s; peak RSS ${result.peakRssMiB} MiB\n`);
  }
  process.stdout.write(save(true));
}
