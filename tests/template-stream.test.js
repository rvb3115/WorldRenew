import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { nbt } from './fixtures.js';
import { sectionFixture, state, makeBlockWorld } from './transfer-fixtures.js';
import { inspectWorld } from '../engine/world.js';
import { captureBuildArchive, saveBuildFile } from '../engine/build-archive.js';
import { TEMPLATE_MAGIC, TEMPLATE_LIMITS, writeTemplateStream, iterateTemplate, validateTemplateStream, selectedTemplateBlocks } from '../engine/template-stream.js';
const sha = b => createHash('sha256').update(b).digest();
function setup(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worldrenew-stream-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
export function streamHeader(bounds = { minX: 0, maxX: 15, minY: 0, maxY: 15, minZ: 0, maxZ: 15 }) {
  return { format: 'WorldRenew.build', schema: 2, createdAt: '2026-10-15T00:00:00Z', source: { name: 'Generated', version: '26.3', dataVersion: 5023, dimensionId: 'minecraft:overworld', dimensionKey: 'overworld', bounds, future: { opaque: ['unchanged', 42] } }, futureHeader: { value: true } };
}
export function streamChunk(x = 0, z = 0, { mask = Buffer.alloc(512, 255), block = (x, y) => state(y === 0 ? 'stone' : x === 0 ? 'cave_air' : 'oak_stairs', y && x ? { facing: 'north', half: 'top', shape: 'straight', waterlogged: 'false' } : undefined) } = {}) {
  const raw = nbt({ DataVersion: [3, 5023], xPos: [3, x], zPos: [3, z], Status: [8, 'minecraft:full'], sections: [9, { type: 10, values: [sectionFixture(0, block)] }], block_entities: [9, { type: 10, values: [] }], block_ticks: [9, { type: 10, values: [] }], fluid_ticks: [9, { type: 10, values: [] }], unknownFuture: [10, { long: [4, 9223372036854775807n], bytes: [7, Buffer.from([0, 255, 42])] }] });
  return { x, z, sections: [{ y: 0, mask, futureSection: 'keep' }], records: { region: raw, entities: null, poi: null }, futureChunk: { bytes: 'uninterpreted' } };
}
function frames(bytes) { const start = TEMPLATE_MAGIC.length + 4 + bytes.readUInt32BE(TEMPLATE_MAGIC.length); return { start, packed: bytes.subarray(start + 41, start + 41 + bytes.readUInt32BE(start + 1)) }; }
function replaceFirstFrame(bytes, edit, extraCompressed = Buffer.alloc(0)) {
  const { start, packed } = frames(bytes), raw = edit(inflateSync(packed));
  const compressed = Buffer.concat([deflateSync(raw), extraCompressed]), envelope = Buffer.alloc(41);
  envelope[0] = 1; envelope.writeUInt32BE(compressed.length, 1); envelope.writeUInt32BE(raw.length, 5); sha(raw).copy(envelope, 9);
  return Buffer.concat([bytes.subarray(0, start), envelope, compressed, bytes.subarray(start + 41 + packed.length)]);
}
test('v2 exact raw records, unknown fields and properties survive selected-air/exclusion round trip', t => {
  const dir = setup(t), file = path.join(dir, 'build.wrbuild'), mask = Buffer.alloc(512); mask[32] = 3; // y1 z0 x0 air, x1 stairs; all other cells excluded
  const header = streamHeader(), chunk = streamChunk(0, 0, { mask });
  chunk.records.futureRecordManifest = { untouched: [1, 'yes'] };
  Object.assign(chunk.sections[0], { palette: 'future metadata', indices: { untouched: true }, selectedCount: 2 });
  const saved = writeTemplateStream(file, header, [chunk]);
  assert.equal(saved.digest, sha(fs.readFileSync(file)).toString('hex'));
  const events = [...iterateTemplate(file)], opened = events[1].chunk;
  assert.deepEqual(events[0].header, header); assert.deepEqual(opened, chunk);
  assert.equal(saved.summary.selectedBlocks, '2'); assert.equal(saved.summary.air, '1');
  const blocks = [...selectedTemplateBlocks(opened)]; assert.equal(blocks.length, 2);
  assert.equal(blocks[0].state.Name, 'minecraft:cave_air'); assert.equal(blocks[1].state.Properties.facing, 'north');
  assert.deepEqual(opened.records.region, chunk.records.region);
});
test('full masks are implicit and disconnected chunks do not include gap cells', t => {
  const dir = setup(t), file = path.join(dir, 'disconnected.wrbuild'), header = streamHeader({ minX: -16, maxX: 30000000, minY: 0, maxY: 15, minZ: -16, maxZ: 15 });
  writeTemplateStream(file, header, [streamChunk(-1, -1), streamChunk(1000000, 0)]);
  const events = [...iterateTemplate(file)]; assert.equal(events.at(-1).summary.selectedBlocks, '8192');
  const raw = inflateSync(frames(fs.readFileSync(file)).packed), metadata = JSON.parse(raw.subarray(4, 4 + raw.readUInt32BE(0)));
  assert.equal(metadata.sections[0].mask, 'full');
  assert.equal(raw.length, 4 + raw.readUInt32BE(0) + events[1].chunk.records.region.length);
});
test('legacy v1 files open through the streaming interface without changing original bytes', t => {
  const dir = setup(t), root = makeBlockWorld(path.join(dir, 'world'), { dataVersion: 5023, block: () => state('air') }), world = inspectWorld(root), file = path.join(dir, 'old.wrbuild');
  const bounds = { minX: 0, maxX: 3, minY: 0, maxY: 3, minZ: 0, maxZ: 3 };
  saveBuildFile(file, captureBuildArchive(world, world.dimensions[0].key, bounds)); const before = fs.readFileSync(file);
  const events = [...iterateTemplate(file)]; assert.equal(events[0].header.legacySchema, 1); assert.equal(events.at(-1).summary.selectedBlocks, '64'); assert.equal(events.at(-1).summary.air, '64');
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(events.at(-1).digest, sha(before).toString('hex'));
});
test('unknown terrain, malformed palettes, missing/duplicate records and out-of-bounds selections fail without publication', t => {
  const dir = setup(t), header = streamHeader();
  for (const [name, edit] of [
    ['missing', c => { c.records.region = null; }],
    ['unknown', c => { c.sections[0].y = 1; }],
    ['empty', c => { c.sections[0].mask.fill(0); }],
    ['duplicate-section', c => { c.sections.push(c.sections[0]); }],
    ['out-of-bounds', c => { c.x = 1; }],
    ['invalid-mask', c => { c.sections[0].mask = Buffer.alloc(4); }],
    ['missing-store', c => { delete c.records.poi; }],
  ]) { const file = path.join(dir, `${name}.wrbuild`), chunk = streamChunk(); edit(chunk); assert.throws(() => writeTemplateStream(file, header, [chunk])); assert.equal(fs.existsSync(file), false); }
  assert.throws(() => writeTemplateStream(path.join(dir, 'duplicates.wrbuild'), header, [streamChunk(), streamChunk()]), /unique/);
  assert.deepEqual(fs.readdirSync(dir), []);
});
test('checksums, footer counts, truncation, decompression bombs, compressed tails and frame lengths are strict', t => {
  const dir = setup(t), file = path.join(dir, 'good.wrbuild'); writeTemplateStream(file, streamHeader(), [streamChunk()]); const bytes = fs.readFileSync(file), { start } = frames(bytes);
  const variants = [];
  const checksum = Buffer.from(bytes); checksum[start + 9] ^= 1; variants.push(checksum);
  const bomb = Buffer.from(bytes); bomb.writeUInt32BE(1, start + 5); variants.push(bomb);
  const huge = Buffer.from(bytes); huge.writeUInt32BE(TEMPLATE_LIMITS.compressedFrame + 1, start + 1); variants.push(huge);
  variants.push(bytes.subarray(0, bytes.length - 1), Buffer.concat([bytes, Buffer.from([0])]), replaceFirstFrame(bytes, b => b, Buffer.from([0, 1, 2])));
  variants.push(replaceFirstFrame(bytes, b => { const m = JSON.parse(b.subarray(4, 4 + b.readUInt32BE(0))); m.sections[0].mask = 'nope'; const json = Buffer.from(JSON.stringify(m)), size = Buffer.alloc(4); size.writeUInt32BE(json.length); return Buffer.concat([size, json, b.subarray(4 + b.readUInt32BE(0))]); }));
  const footerChanged = Buffer.from(bytes); footerChanged[footerChanged.length - 4] ^= 1; variants.push(footerChanged);
  for (const [i, bad] of variants.entries()) { const target = path.join(dir, `bad-${i}.wrbuild`); fs.writeFileSync(target, bad); assert.throws(() => validateTemplateStream(target), `variant ${i}`); }
});
test('cancellation, custom budgets, final source check and early iterator return clean up', t => {
  const dir = setup(t), file = path.join(dir, 'cancelled.wrbuild'), controller = new AbortController();
  assert.throws(() => writeTemplateStream(file, streamHeader(), [streamChunk()], { signal: controller.signal, onProgress: () => controller.abort() }), { code: 'TEMPLATE_CANCELLED' }); assert.deepEqual(fs.readdirSync(dir), []);
  assert.throws(() => writeTemplateStream(file, streamHeader(), [streamChunk()], { maxSelectedBlocks: 1 }), { code: 'TEMPLATE_BUDGET' });
  assert.throws(() => writeTemplateStream(file, streamHeader(), [streamChunk()], { beforePublish: () => { throw Error('changed'); } }), /changed/); assert.deepEqual(fs.readdirSync(dir), []);
  writeTemplateStream(file, streamHeader(), [streamChunk()]);
  assert.throws(() => validateTemplateStream(file, { maxExpandedBytes: 1 }), { code: 'TEMPLATE_BUDGET' });
  assert.throws(() => validateTemplateStream(file, { shouldCancel: () => true }), { code: 'TEMPLATE_CANCELLED' });
  const iterator = iterateTemplate(file); assert.equal(iterator.next().value.type, 'header'); iterator.return(); fs.renameSync(file, file + '-renamed');
});

test('low-level publication detects tempfile mutation and replacement after validation', t => {
  const dir = setup(t), file = path.join(dir, 'must-not-publish.wrbuild');
  for (const replace of [false, true]) {
    assert.throws(() => writeTemplateStream(file, streamHeader(), [streamChunk()], { beforePublish() {
      const temporary = path.join(dir, fs.readdirSync(dir).find(n => n.endsWith('.partial')));
      if (replace) fs.unlinkSync(temporary);
      fs.writeFileSync(temporary, 'unverified bytes');
    } }), { code: 'TEMPLATE_CHANGED' });
    assert.deepEqual(fs.readdirSync(dir), []);
  }
});

test('writer returns persisted header metadata even if caller changes its input in a hook', t => {
  const dir = setup(t), file = path.join(dir, 'header.wrbuild'), header = streamHeader();
  const saved = writeTemplateStream(file, header, [streamChunk()], { beforePublish() { header.futureHeader.value = false; } });
  assert.equal(saved.header.futureHeader.value, true);
  assert.deepEqual(saved.header, validateTemplateStream(file).header);
});
