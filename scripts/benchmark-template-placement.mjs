#!/usr/bin/env node
/** Generated fixtures only; no user saves. Default selection exceeds 1M cells. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { deflateSync } from 'node:zlib';
import { nbt, writeDat } from '../tests/fixtures.js';
import { sectionFixture, state } from '../tests/transfer-fixtures.js';
import { inspectWorld } from '../engine/world.js';
import { createSparseSelection } from '../engine/sparse-selection.js';
import { captureTemplateStream } from '../engine/template-capture.js';
import { iterateTemplate } from '../engine/template-stream.js';
import { previewTemplatePlacement, createTemplatePlacedCopy } from '../engine/template-placement.js';
import { createChunkReader, decodeSection, stateKey } from '../engine/chunks.js';
import { compound, field, readTypedNBT, writeTypedNBT } from '../engine/typed-nbt.js';
import { hashFile, inventory } from '../engine/safety.js';

const MiB = 1024 ** 2;
const round = value => Math.round(value * 1000) / 1000;
const mod = (value, divisor) => (value % divisor + divisor) % divisor;
const offset = { x: 16, y: 0, z: 16 };
const anchor = { x: 16, y: -64, z: 16 };
const distant = { x: 512, y: 0, z: 0 };
const exclusion = { x: 5, y: 0, z: 5 };
const sectionYs = Array.from({ length: 24 }, (_, index) => index - 4);
const dimensionOf = world => world.dimensions.find(value => value.id === 'minecraft:overworld');
const fileHashes = root => Object.fromEntries(inventory(root).files.map(file => [file.path, hashFile(path.join(root, file.path))]));
const typedFieldBytes = (root, name) => writeTypedNBT(compound({ preserved: field(root, name) }));

function sourceBlock(x, y, z) {
  const ly = mod(y, 16), section = Math.floor(y / 16) + 4;
  if (ly === 0) return state(['oak_planks', 'stone_bricks', 'quartz_block'][section % 3]);
  if (x === 0 || x === 15 || z === 0 || z === 15) return state(ly >= 4 && ly <= 8 ? 'glass' : 'bricks');
  if (x === 4 && z === 4 && ly === 1) return state('oak_stairs', { facing: ['north', 'east', 'south', 'west'][section % 4], half: 'top', shape: 'outer_left', waterlogged: 'false' });
  return state(['air', 'cave_air', 'void_air'][section % 3]);
}
const chestTags = (x, y, z) => ({ id: [8, 'minecraft:chest'], x: [3, x], y: [3, y], z: [3, z], Items: [9, { type: 10, values: [{ Slot: [1, 4], id: [8, 'minecraft:diamond'], count: [3, 23], future: [4, 9007199254740993n] }] }], unknown: [7, Buffer.from([255, 0, 128, 3])] });

function writeWorld(root, chunks, source, blueprints) {
  writeDat(path.join(root, 'level.dat'), { Data: [10, { LevelName: [8, source ? 'Generated source benchmark' : 'Generated destination benchmark'], DataVersion: [3, 4903], Version: [10, { Name: [8, '26.2'], Id: [3, 4903], Snapshot: [1, 0] }] }] });
  if (!source) writeDat(path.join(root, 'playerdata/00000000-0000-0000-0000-000000000001.dat'), { Inventory: [9, { type: 10, values: [{ Slot: [1, 2], id: [8, 'minecraft:diamond'], count: [3, 64], future: [4, -9223372036854775807n] }] }], future_player: [7, Buffer.from([255, 4, 0, 128])] });
  const grouped = new Map();
  for (const chunk of chunks) {
    const key = `${Math.floor(chunk.x / 32)},${Math.floor(chunk.z / 32)}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(chunk);
  }
  for (const [key, entries] of grouped) {
    const [rx, rz] = key.split(','), file = path.join(root, 'dimensions/minecraft/overworld/region', `r.${rx}.${rz}.mca`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, 'wx', 0o600), header = Buffer.alloc(8192);
    let sector = 2;
    try {
      fs.writeSync(fd, header);
      for (const { x, z } of entries) {
        const hasChest = x === (source ? 0 : 1) && z === (source ? 0 : 1);
        const sections = source ? blueprints.source : blueprints.destination;
        const selection = hasChest ? sections.map(section => section.Y[1] === 0 ? (source ? blueprints.sourceChest : blueprints.destinationChest) : section) : sections;
        const raw = nbt({ DataVersion: [3, 4903], xPos: [3, x], zPos: [3, z], Status: [8, 'minecraft:full'],
          sections: [9, { type: 10, values: selection }], block_entities: [9, { type: 10, values: hasChest ? [chestTags(x * 16 + 5, 0, z * 16 + 5)] : [] }],
          block_ticks: [9, { type: 10, values: [] }], fluid_ticks: [9, { type: 10, values: [] }],
          FutureOpaque: [10, { exactLong: [4, 9223372036854775807n], bytes: [7, Buffer.from([0, 255, 128, 1])], text: [8, 'generated\0future 🌲'], preciseFloat: [5, NaN] }],
        });
        const packed = deflateSync(raw), count = Math.ceil((packed.length + 5) / 4096), record = Buffer.alloc(count * 4096), slot = mod(x, 32) + mod(z, 32) * 32;
        assert.ok(count <= 255);
        header.writeUInt32BE(sector * 256 + count, slot * 4); header.writeUInt32BE(1234, 4096 + slot * 4);
        record.writeUInt32BE(packed.length + 1); record[4] = 2; packed.copy(record, 5);
        fs.writeSync(fd, record); sector += count;
      }
      fs.writeSync(fd, header, 0, header.length, 0); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  }
}

function makeFixture(directory, config) {
  const sourceChunks = [];
  for (let z = 0; z < config.depth; z++) for (let x = 0; x < config.width; x++) sourceChunks.push({ x, z });
  sourceChunks.push({ x: Math.floor(distant.x / 16), z: 0 });
  const targetChunks = new Map();
  for (const source of sourceChunks) for (let z = source.z; z <= source.z + 2; z++) for (let x = source.x; x <= source.x + 2; x++) targetChunks.set(`${x},${z}`, { x, z });
  const blueprints = {
    source: sectionYs.map(y => sectionFixture(y, sourceBlock)),
    destination: sectionYs.map(y => sectionFixture(y, () => state('stone'))),
    sourceChest: sectionFixture(0, (x, y, z) => x === 5 && y === 0 && z === 5 ? state('chest', { facing: 'north', type: 'single', waterlogged: 'false' }) : sourceBlock(x, y, z)),
    destinationChest: sectionFixture(0, (x, y, z) => state(x === 5 && y === 0 && z === 5 ? 'chest' : 'stone')),
  };
  const source = path.join(directory, 'generated-source'), destination = path.join(directory, 'generated-destination');
  writeWorld(source, sourceChunks, true, blueprints); writeWorld(destination, [...targetChunks.values()], false, blueprints);
  const selection = createSparseSelection({ x: 0, y: -64, z: 0 }, { x: config.width * 16 - 1, y: 319, z: config.depth * 16 - 1 })
    .removeBlock(exclusion.x, exclusion.y, exclusion.z).addBlock(distant.x, distant.y, distant.z);
  return { source, destination, selection, sourceChunks, targetChunks: [...targetChunks.values()] };
}

function verifyPlacement(fixture, output, config, progress) {
  const source = inspectWorld(fixture.source), before = inspectWorld(fixture.destination), after = inspectWorld(output.world);
  const sourceDimension = dimensionOf(source), beforeDimension = dimensionOf(before), afterDimension = dimensionOf(after);
  const sourceKeys = new Set(fixture.sourceChunks.map(chunk => `${chunk.x},${chunk.z}`));
  let selected = 0, excluded = 0, chunkCount = 0;
  const selectedDigest = createHash('sha256'), excludedDigest = createHash('sha256');
  for (const { x, z } of fixture.targetChunks) {
    progress({ phase: 'Independently verifying every destination cell', chunks: chunkCount++ });
    // Readers are released for each chunk, so independent verification does
    // not introduce a cumulative raw-record cache or a whole-world volume.
    const old = createChunkReader(before.root, beforeDimension).read(x, z), current = createChunkReader(after.root, afterDimension).read(x, z);
    const sx = x - 1, sz = z - 1, original = sourceKeys.has(`${sx},${sz}`) ? createChunkReader(source.root, sourceDimension).read(sx, sz) : null;
    const oldTyped = readTypedNBT(old.raw), currentTyped = readTypedNBT(current.raw);
    for (const name of ['FutureOpaque', 'block_entities', 'block_ticks', 'fluid_ticks']) assert.deepEqual(typedFieldBytes(currentTyped, name), typedFieldBytes(oldTyped, name));
    for (const sy of sectionYs) {
      const a = decodeSection(old.nbt.sections.find(section => section.Y === sy)), b = decodeSection(current.nbt.sections.find(section => section.Y === sy));
      const s = original ? decodeSection(original.nbt.sections.find(section => section.Y === sy)) : null;
      const oldKeys = a.palette.map(stateKey), newKeys = b.palette.map(stateKey), sourceStateKeys = s?.palette.map(stateKey);
      for (let i = 0; i < 4096; i++) {
        const px = sx * 16 + i % 16, py = sy * 16 + (i >> 8), pz = sz * 16 + ((i >> 4) & 15);
        const main = px >= 0 && px < config.width * 16 && pz >= 0 && pz < config.depth * 16;
        const included = (main && !(px === exclusion.x && py === exclusion.y && pz === exclusion.z)) || (px === distant.x && py === distant.y && pz === distant.z);
        const actual = newKeys[b.indices[i]], expected = included ? sourceStateKeys[s.indices[i]] : oldKeys[a.indices[i]];
        assert.equal(actual, expected, `Unexpected cell at ${px + offset.x},${py},${pz + offset.z}`);
        if (included) { selected++; selectedDigest.update(actual + '\n'); }
        else { excluded++; excludedDigest.update(actual + '\n'); }
      }
    }
  }
  return { selectedCells: String(selected), excludedCells: String(excluded), selectedStatesSha256: selectedDigest.digest('hex'), excludedStatesSha256: excludedDigest.digest('hex') };
}

function run(config) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worldrenew-template-placement-bench-'));
  const startRssBytes = process.memoryUsage().rss;
  let peakSampledRssBytes = startRssBytes, lastNotice = 0, lastPhase = null, progressCalls = 0;
  const events = {};
  const progress = event => {
    progressCalls++; events[event.phase] = (events[event.phase] ?? 0) + 1;
    peakSampledRssBytes = Math.max(peakSampledRssBytes, process.memoryUsage().rss);
    const now = performance.now();
    if (event.phase !== lastPhase || now - lastNotice >= 15000) {
      process.stderr.write(`[placement benchmark] ${event.phase}; RSS ${round(process.memoryUsage().rss / MiB)} MiB\n`);
      lastNotice = now; lastPhase = event.phase;
    }
  };
  const timings = {}, measure = (name, fn) => {
    const started = performance.now(), result = fn();
    timings[name] = round((performance.now() - started) / 1000);
    progress({ phase: `Finished ${name}` }); return result;
  };
  try {
    const fixture = measure('fixtureGenerationSeconds', () => makeFixture(directory, config));
    const beforeSource = fileHashes(fixture.source), beforeDestination = fileHashes(fixture.destination);
    const source = inspectWorld(fixture.source), destination = inspectWorld(fixture.destination), file = path.join(directory, 'generated-build.wrbuild');
    const captured = measure('captureAndRevalidateSeconds', () => captureTemplateStream(file, source, dimensionOf(source).key, fixture.selection, { onProgress: progress }));
    const expectedSelected = String(config.width * config.depth * 16 * 16 * 384);
    assert.equal(captured.summary.selectedBlocks, expectedSelected);
    assert.ok(BigInt(captured.summary.air) > 0n && BigInt(captured.summary.nonAir) > 0n);
    if (!config.quick) assert.ok(BigInt(expectedSelected) > 1000000n);
    const fileBytes = fs.statSync(file).size;
    const preview = measure('previewSeconds', () => previewTemplatePlacement(file, destination, dimensionOf(destination).key, anchor, { onProgress: progress }));
    assert.deepEqual(preview.blockers, []); assert.equal(preview.copyEligible, true);
    const output = measure('exportSeconds', () => createTemplatePlacedCopy(file, destination, dimensionOf(destination).key, anchor, directory, { confirmedClosed: true, reviewDigest: preview.reviewDigest, onProgress: progress }));
    const verified = measure('independentVerificationSeconds', () => {
      const checks = verifyPlacement(fixture, output, config, progress);
      assert.equal(checks.selectedCells, expectedSelected);
      assert.deepEqual(fileHashes(fixture.source), beforeSource); assert.deepEqual(fileHashes(fixture.destination), beforeDestination); assert.deepEqual(fileHashes(output.backup), beforeDestination);
      const afterHashes = fileHashes(output.world);
      for (const [name, digest] of Object.entries(beforeDestination)) if (!name.includes('/region/')) assert.equal(afterHashes[name], digest);
      let chunks = 0;
      for (const event of iterateTemplate(file)) if (event.type === 'chunk') {
        const reader = createChunkReader(source.root, dimensionOf(source));
        assert.deepEqual(event.chunk.records.region, reader.read(event.chunk.x, event.chunk.z).raw); chunks++;
      }
      assert.equal(chunks, fixture.sourceChunks.length);
      assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.partial')), false);
      return { ...checks, sourceUnchanged: true, destinationUnchanged: true, backupByteIdentical: true, playerDataByteIdentical: true, excludedInventoriesAndOpaqueMetadataByteIdentical: true, archiveRawRecordsByteIdentical: true, noPartialOutput: true };
    });
    const report = JSON.parse(fs.readFileSync(output.report));
    assert.equal(report.gameLoadTested, false); assert.equal(report.blocks, expectedSelected);
    return {
      name: config.quick ? 'quick-sparse-full-height' : 'million-sparse-full-height', ...config,
      sourceChunks: fixture.sourceChunks.length, destinationChunks: fixture.targetChunks.length,
      selectedBlocks: expectedSelected, selectedAir: captured.summary.air, selectedNonAir: captured.summary.nonAir,
      boundingBlocks: String(BigInt(513) * 384n * BigInt(config.depth * 16)),
      sourceRawBytes: Number(captured.summary.rawBytes), archiveBytes: fileBytes, archiveMiB: round(fileBytes / MiB), archiveDigest: captured.digest,
      ...timings, previewSelectedMillionBlocksPerSecond: round(Number(expectedSelected) / timings.previewSeconds / 1e6), exportSelectedMillionBlocksPerSecond: round(Number(expectedSelected) / timings.exportSeconds / 1e6),
      startRssMiB: round(startRssBytes / MiB), sampledPeakRssMiB: round(peakSampledRssBytes / MiB), peakRssMiB: round(process.resourceUsage().maxRSS / 1024),
      progressCalls, progressPhases: events, modifiedRegionCount: report.modifiedRegionCount, lightingChunks: report.lightingChunks,
      verified, gameLoadTested: report.gameLoadTested,
    };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

const args = process.argv.slice(2);
if (args[0] === '--child') process.stdout.write(JSON.stringify(run(JSON.parse(args[1]))) + '\n');
else {
  let quick = false, output = null;
  const usage = () => { throw new Error('Usage: node scripts/benchmark-template-placement.mjs [--quick] [--output FILE]'); };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--quick') quick = true;
    else if (args[i] === '--output') { output = args[++i]; if (!output || output.startsWith('--')) usage(); }
    else usage();
  }
  const config = { width: quick ? 1 : 4, depth: quick ? 1 : 3, height: 384, quick };
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', JSON.stringify(config)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: MiB, timeout: 20 * 60 * 1000 });
  if (child.error || child.status !== 0) throw new Error(`Placement benchmark failed: ${child.error?.message ?? `child exit ${child.status}`}`);
  const report = {
    command: ['node', 'scripts/benchmark-template-placement.mjs', ...args].join(' '), timestamp: new Date().toISOString(), complete: true,
    environment: { node: process.version, platform: process.platform, arch: process.arch, release: os.release(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemoryGiB: round(os.totalmem() / 1024 ** 3) },
    methodology: `Generated fixtures only, in one fresh child process. Full-height ${config.width}x${config.depth} main chunks exclude one chest/inventory cell and add one disconnected cell 512 blocks away; the selected total is unchanged. Only required destination lighting neighborhoods exist; intervening terrain is absent. Source contains mixed building blocks, three intentional air variants, exact stair properties and opaque NBT. Capture includes automatic archive validation. Preview includes safety gates and typed preflight. Export includes fresh preview, verified backup/working copies, repeated validation, bounded chunk/region rewrite, full file verification and atomic publication. Independent verification compares every selected and excluded cell in all destination chunks, preserved typed metadata, archive raw terrain bytes, and all original/backup file hashes. maxRSS is the OS process peak in KiB reported by Node, divided by 1024 for MiB; it includes fixture generation, all measured stages and independent verification, with no forced GC. The fixture is deliberately repetitive; compression ratio is not representative of every real build. No Minecraft game-load test, UI test or cancellation benchmark is included. Temporary fixture worlds, template, backup and result copy are deleted after measurement.`,
    result: JSON.parse(child.stdout),
  };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (output) fs.writeFileSync(path.resolve(output), json);
  process.stdout.write(json);
}
