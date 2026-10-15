import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { nbt, emptyRecordTags } from './fixtures.js';
import { makeBlockWorld, writeBlockChunk, sectionFixture, state } from './transfer-fixtures.js';
import { inspectWorld } from '../engine/world.js';
import { createChunkReader } from '../engine/chunks.js';
import { createSparseSelection, SparseSelection } from '../engine/sparse-selection.js';
import { captureTemplateStream } from '../engine/template-capture.js';
import { iterateTemplate, selectedTemplateBlocks } from '../engine/template-stream.js';

const dimensionPath = 'dimensions/minecraft/overworld';
function setup(t, { second = false, external = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'worldrenew-capture-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = makeBlockWorld(path.join(base, 'source'), { dataVersion: 5023, external, sections: [0], block: (x, y) => state(y === 0 ? 'stone' : x === 0 ? 'cave_air' : 'oak_stairs', y === 0 || x === 0 ? undefined : { facing: 'north', half: 'top', shape: 'straight', waterlogged: 'false' }) });
  if (second) writeBlockChunk(path.join(root, dimensionPath, 'region/r.1.0.mca'), { x: 32, sections: [0], dataVersion: 5023, block: () => state('oak_planks') });
  const world = inspectWorld(root), dimension = world.dimensions.find(value => value.id === 'minecraft:overworld'), file = path.join(base, 'capture.wrbuild');
  return { base, root, world, dimension, file };
}
function writeRecord(root, store, x, raw, { external = false } = {}) {
  const folder = path.join(root, dimensionPath, store), packed = deflateSync(raw);
  fs.mkdirSync(folder, { recursive: true });
  const sectors = external ? 1 : Math.ceil((packed.length + 5) / 4096), bytes = Buffer.alloc((2 + sectors) * 4096);
  bytes.writeUInt32BE(512 + sectors, (x % 32) * 4); bytes.writeUInt32BE(external ? 1 : packed.length + 1, 8192); bytes[8196] = 2 | (external ? 128 : 0);
  if (external) fs.writeFileSync(path.join(folder, `c.${x}.0.mcc`), packed); else packed.copy(bytes, 8197);
  fs.writeFileSync(path.join(folder, `r.${Math.floor(x / 32)}.0.mca`), bytes);
}
const twoBlocks = () => createSparseSelection({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }).addBlock(512, 0, 0);
function assertClean(f) {
  assert.equal(fs.existsSync(f.file), false);
  assert.deepEqual(fs.readdirSync(f.base), ['source'], 'No journal or partial archive remains.');
}
function mutate(file) {
  const original = fs.statSync(file), bytes = fs.readFileSync(file);
  // A header timestamp edit preserves all NBT and selected states. Restoring the
  // old mtime must not conceal the edit from the nanosecond ctime observation.
  bytes[4096] ^= 1; fs.writeFileSync(file, bytes); fs.utimesSync(file, original.atime, original.mtime);
}

test('capture preserves refined disconnected masks, exact air states, supporting bytes and portable provenance', t => {
  const f = setup(t, { second: true }), entities = nbt({ ...emptyRecordTags(0, 0, 'entities'), future_entity_metadata: [10, { long: [4, 9007199254740993n], bytes: [7, Buffer.from([0, 255, 128])] }] });
  const poi = nbt({ ...emptyRecordTags(0, 0, 'poi'), future_poi_metadata: [8, 'preserve me'] });
  writeRecord(f.root, 'entities', 0, entities); writeRecord(f.root, 'poi', 0, poi);
  const selection = createSparseSelection({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }).removeBlock(1, 0, 0).addBlock(512, 0, 0);
  const expectedRaw = createChunkReader(f.root, f.dimension).read(0, 0).raw, events = [];
  const result = captureTemplateStream(f.file, f.world, f.dimension.key, selection, { onProgress: progress => events.push(progress) });
  assert.equal(result.summary.chunks, 2); assert.equal(result.summary.selectedBlocks, '4'); assert.equal(result.summary.air, '1');
  const records = [...iterateTemplate(f.file)], chunks = records.filter(record => record.type === 'chunk').map(record => record.chunk);
  assert.deepEqual(chunks.map(chunk => [chunk.x, chunk.z]), [[0, 0], [32, 0]]);
  assert.deepEqual(chunks[0].records.region, expectedRaw); assert.deepEqual(chunks[0].records.entities, entities); assert.deepEqual(chunks[0].records.poi, poi);
  const blocks = chunks.flatMap(chunk => [...selectedTemplateBlocks(chunk)]);
  assert.equal(blocks.some(block => block.x === 1 && block.y === 0), false);
  assert.deepEqual(blocks.find(block => block.x === 0 && block.y === 1).state, state('cave_air'));
  assert.deepEqual(blocks.find(block => block.x === 1 && block.y === 1).state, state('oak_stairs', { facing: 'north', half: 'top', shape: 'straight', waterlogged: 'false' }));
  assert.equal(JSON.stringify(result.header).includes(f.base), false);
  assert.ok(events.some(event => event.phase === 'Capturing template')); assert.ok(events.some(event => event.phase === 'Verifying template source'));
  assert.equal(fs.readdirSync(f.base).some(name => name.endsWith('.journal') || name.endsWith('.partial')), false);
  fs.renameSync(f.root, path.join(f.base, 'offline-source'));
  assert.equal([...iterateTemplate(f.file)].at(-1).digest, result.digest);
});

test('unknown terrain chunks and absent sections never become selected air', t => {
  const f = setup(t);
  assert.throws(() => captureTemplateStream(f.file, f.world, f.dimension.key, twoBlocks()), { code: 'ARCHIVE_UNKNOWN' }); assertClean(f);
  const missingSection = createSparseSelection({ x: 0, y: 16, z: 0 }, { x: 0, y: 16, z: 0 });
  assert.throws(() => captureTemplateStream(f.file, f.world, f.dimension.key, missingSection), { code: 'TEMPLATE_UNKNOWN' }); assertClean(f);
  assert.throws(() => captureTemplateStream(f.file, f.world, f.dimension.key, new SparseSelection()), { code: 'ARCHIVE_SELECTION' }); assertClean(f);
});

test('capture snapshots selection masks, count and bounds before progress callbacks can edit them', t => {
  const f = setup(t, { second: true }), selection = twoBlocks(); let edited = false;
  const result = captureTemplateStream(f.file, f.world, f.dimension.key, selection, { onProgress(event) {
    if (!edited && event.phase === 'Capturing template') { edited = true; selection.removeBlock(512, 0, 0).addBlock(513, 0, 0); }
  } });
  const blocks = [...iterateTemplate(f.file)].filter(record => record.type === 'chunk').flatMap(record => [...selectedTemplateBlocks(record.chunk)]);
  assert.deepEqual(blocks.map(block => block.x), [0, 512]); assert.equal(result.header.source.bounds.maxX, 512);
  assert.equal(selection.contains(513, 0, 0), true); assert.equal(selection.contains(512, 0, 0), false);
});

test('an earlier terrain file edit is detected after its reader has been released', t => {
  const f = setup(t, { second: true }); let edited = false;
  assert.throws(() => captureTemplateStream(f.file, f.world, f.dimension.key, twoBlocks(), { onProgress(event) {
    if (!edited && event.phase === 'Capturing template' && event.x === 32) { edited = true; mutate(path.join(f.root, dimensionPath, 'region/r.0.0.mca')); }
  } }), { code: 'ARCHIVE_CHANGED' });
  assert.ok(edited); assertClean(f);
});

test('source changes from late verification and before-publication hooks invalidate the file', t => {
  const f = setup(t, { second: true }); let edited = false;
  assert.throws(() => captureTemplateStream(f.file, f.world, f.dimension.key, twoBlocks(), { onProgress(event) {
    if (!edited && event.phase === 'Verifying template source' && event.x === 32) { edited = true; mutate(path.join(f.root, dimensionPath, 'region/r.0.0.mca')); }
  } }), { code: 'ARCHIVE_CHANGED' }); assertClean(f);
  assert.throws(() => captureTemplateStream(f.file, f.world, f.dimension.key, twoBlocks(), { beforePublish() { mutate(path.join(f.root, dimensionPath, 'region/r.0.0.mca')); } }), { code: 'ARCHIVE_CHANGED' }); assertClean(f);
});

test('external records and formerly absent optional stores are included in consistency checks', t => {
  const f = setup(t, { second: true, external: true }); let edited = false;
  assert.throws(() => captureTemplateStream(f.file, f.world, f.dimension.key, twoBlocks(), { onProgress(event) {
    if (!edited && event.phase === 'Capturing template' && event.x === 32) { edited = true; fs.appendFileSync(path.join(f.root, dimensionPath, 'region/c.0.0.mcc'), Buffer.from([0])); }
  } }), { code: 'ARCHIVE_CHANGED' }); assertClean(f);
  // Rebuild the first source chunk, then create a supporting store that was
  // absent when its terrain chunk was captured.
  writeBlockChunk(path.join(f.root, dimensionPath, 'region/r.0.0.mca'), { external: true, dataVersion: 5023, sections: [0] });
  let created = false;
  assert.throws(() => captureTemplateStream(f.file, f.world, f.dimension.key, twoBlocks(), { onProgress(event) {
    if (!created && event.phase === 'Capturing template' && event.x === 32) { created = true; writeRecord(f.root, 'entities', 0, nbt(emptyRecordTags(0, 0, 'entities'))); }
  } }), { code: 'ARCHIVE_CHANGED' }); assertClean(f);
});

test('metadata staleness, generation-setting creation and source-world output are rejected', t => {
  const f = setup(t, { second: true }), selection = twoBlocks();
  assert.throws(() => captureTemplateStream(path.join(f.root, 'bad.wrbuild'), f.world, f.dimension.key, selection), { code: 'ARCHIVE_IN_WORLD' });
  assert.equal(fs.existsSync(path.join(f.root, 'bad.wrbuild')), false);
  let created = false;
  assert.throws(() => captureTemplateStream(f.file, f.world, f.dimension.key, selection, { onProgress(event) {
    if (!created && event.phase === 'Capturing template' && event.x === 32) {
      created = true; const file = path.join(f.root, 'data/minecraft/world_gen_settings.dat'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, nbt({ data: [10, { seed: [4, 1n] }] }));
    }
  } }), { code: 'ARCHIVE_CHANGED' }); assertClean(f);
  fs.appendFileSync(path.join(f.root, 'level.dat'), Buffer.from([1]));
  assert.throws(() => captureTemplateStream(f.file, f.world, f.dimension.key, selection), { code: 'ARCHIVE_CHANGED' }); assertClean(f);
});

test('abort signals and shared cancellation predicates discard every temporary file', t => {
  const f = setup(t, { second: true }), controller = new AbortController();
  assert.throws(() => captureTemplateStream(f.file, f.world, f.dimension.key, twoBlocks(), { signal: controller.signal, onProgress(event) {
    if (event.phase === 'Capturing template' && event.x === 32) controller.abort();
  } }), { code: 'TEMPLATE_CANCELLED' }); assertClean(f);
  let cancelled = false;
  assert.throws(() => captureTemplateStream(f.file, f.world, f.dimension.key, twoBlocks(), { shouldCancel: () => cancelled, onProgress(event) {
    if (event.phase === 'Capturing template' && event.x === 32) cancelled = true;
  } }), { code: 'TEMPLATE_CANCELLED' }); assertClean(f);
});

test('capture exceeds the old 128 MiB cumulative reader budget with bounded per-chunk records', t => {
  const f = setup(t), selection = new SparseSelection(), unknown = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`future_${index}`, [7, Buffer.alloc(900_000, index)]]));
  for (let index = 0; index < 10; index++) {
    const x = index * 32, raw = nbt({ ...emptyRecordTags(x, 0), sections: [9, { type: 10, values: [sectionFixture(0, () => state('stone'))] }], ...unknown });
    writeRecord(f.root, 'region', x, raw, { external: true }); selection.addBlock(x * 16, 0, 0);
  }
  const result = captureTemplateStream(f.file, f.world, f.dimension.key, selection);
  assert.equal(result.summary.chunks, 10); assert.equal(result.summary.selectedBlocks, '10'); assert.ok(BigInt(result.summary.rawBytes) > 128n * 1024n * 1024n);
  assert.ok(fs.statSync(f.file).size < 256 * 1024, 'Highly repetitive unknown fields remain lossless and compress well.');
});
