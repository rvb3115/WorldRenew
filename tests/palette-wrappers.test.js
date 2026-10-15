import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { nbt } from './fixtures.js';
import { makeBlockWorld } from './transfer-fixtures.js';
import { parseNBT } from '../engine/nbt.js';
import { decodeSection, isAir, stateKey, createChunkReader } from '../engine/chunks.js';
import { captureVolume, volumeBlock } from '../engine/volumes.js';
import { inspectWorld } from '../engine/world.js';
import { captureBuildArchive, validateBuildArchive, saveBuildFile, readBuildFile } from '../engine/build-archive.js';
import { placeableState } from '../engine/copy-placement.js';
import { resolveModel } from '../engine/models.js';

const unfamiliar = { Name: 'example.future:new/block-v2', Properties: { new_property: 'unrecognized_value', orientation: 'north_east', powered: 'false' } };
const properties = Object.fromEntries(Object.entries(unfamiliar.Properties).map(([key, value]) => [key, [8, value]]));
const modern = { id: [8, unfamiliar.Name], properties: [10, properties] };
const legacy = { Name: [8, unfamiliar.Name], Properties: [10, properties] };
const alternating = Array(256).fill(0x1010101010101010n);
function section(y, encoding = 'mixed') {
  const entries = encoding === 'legacy' ? [{ Name: [8, 'minecraft:air'] }, legacy]
    : encoding === 'invalid' ? [{ '': [8, 'minecraft:air'], id: [8, 'minecraft:stone'] }, modern]
    : [{ '': [8, 'minecraft:air'] }, modern];
  return { Y: [1, y], block_states: [10, { palette: [9, { type: 10, values: entries }], data: [12, alternating] }] };
}
function binarySection(encoding) { return parseNBT(nbt({ section: [10, section(-4, encoding)] })).section; }

test('binary mixed palette unwraps only compact strings and preserves arbitrary named states/properties', () => {
  const parsed = binarySection('mixed'), before = structuredClone(parsed);
  const decoded = decodeSection(parsed);
  assert.deepEqual(decoded.palette, [{ Name: 'minecraft:air' }, unfamiliar]);
  assert.deepEqual(structuredClone(parsed), before);
  for (let i = 0; i < 4096; i++) assert.equal(decoded.indices[i], i % 2);
  assert.equal(isAir(decoded.palette[1]), false);
  assert.equal(placeableState(decoded.palette[1]), false, 'Unknown valid ID must not authorize placement');
  assert.equal(resolveModel({ json: () => null }, decoded.palette[1]), null, 'Missing assets use the existing visual fallback');
});

test('legacy and modern binary palettes normalize to the same states without changing stored NBT', () => {
  assert.deepEqual(decodeSection(binarySection('legacy')), decodeSection(binarySection('mixed')));
  const raw = nbt({ section: [10, section(0)] });
  const parsed = parseNBT(raw);
  decodeSection(parsed.section);
  assert.deepEqual(Object.keys(parsed.section.block_states.palette[0]), ['']);
});

for (const [label, paletteTag] of [
  ['strings', [9, { type: 8, values: [unfamiliar.Name] }]],
  ['wrapped string', [9, { type: 10, values: [{ '': [8, unfamiliar.Name] }] }]],
  ['legacy', [9, { type: 10, values: [legacy] }]],
  ['modern', [9, { type: 10, values: [modern] }]],
]) test(`${label} binary singleton preserves unfamiliar valid names without inventing properties`, () => {
  const parsed = parseNBT(nbt({ s: [10, { Y: [1, 0], block_states: [10, { palette: paletteTag }] }] })).s;
  assert.deepEqual(decodeSection(parsed).palette[0], label === 'legacy' || label === 'modern' ? unfamiliar : { Name: unfamiliar.Name });
});

test('legacy, modern and wrapped states can coexist in one binary palette', () => {
  const entries = [legacy, modern, { '': [8, 'minecraft:stone'] }];
  const parsed = parseNBT(nbt({ s: [10, { Y: [1, 0], block_states: [10, { palette: [9, { type: 10, values: entries }], data: [12, Array(256).fill(0n)] }] }] })).s;
  const decoded = decodeSection(parsed);
  assert.equal(stateKey(decoded.palette[0]), stateKey(decoded.palette[1]));
  assert.deepEqual(decoded.palette[2], { Name: 'minecraft:stone' });
});

for (const entry of [
  { '': 'minecraft:stone', id: 'minecraft:stone' },
  { '': 'minecraft:stone', Name: 'minecraft:stone' },
  { '': 'minecraft:stone', properties: {} },
  { '': 'minecraft:stone', extra: true },
  { '': { '': 'minecraft:stone' } }, { '': { id: 'minecraft:stone' } },
  { '': [] }, { '': null }, { '': 0 }, { '': '' }, { '': 'STONE' },
  { Name: 'minecraft:stone', id: 'minecraft:stone' },
  { id: unfamiliar.Name, properties: { future_property: 1 } },
]) test(`ambiguous or unsupported encoding stays blocked: ${JSON.stringify(entry)}`, () => {
  assert.throws(() => decodeSection({ Y: 0, block_states: { palette: [entry] } }), { code: 'BLOCK_STATE' });
});

const bounds = { minX: -656, maxX: -609, minY: -64, maxY: 319, minZ: -176, maxZ: -129 };
function nineChunkWorld(t, bad = false) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'worldrenew-wrapper-fixture-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = makeBlockWorld(path.join(base, 'synthetic'), { x: -40, z: -11, dataVersion: 5023 });
  const header = Buffer.alloc(8192), records = []; let sector = 2;
  for (let z = -11; z <= -9; z++) for (let x = -41; x <= -39; x++) {
    const old = x === -40 && z === -11;
    const raw = nbt({ DataVersion: [3, old ? 4903 : 5023], xPos: [3, x], zPos: [3, z], Status: [8, 'minecraft:full'],
      sections: [9, { type: 10, values: Array.from({ length: 24 }, (_, i) => section(i - 4, bad && x === -41 && z === -11 ? 'invalid' : old ? 'legacy' : 'mixed')) }],
      block_entities: [9, { type: 10, values: [] }], block_ticks: [9, { type: 10, values: [] }], fluid_ticks: [9, { type: 10, values: [] }] });
    const packed = deflateSync(raw), sectors = Math.ceil((packed.length + 5) / 4096), record = Buffer.alloc(sectors * 4096);
    header.writeUInt32BE((sector << 8) | sectors, (((x % 32 + 32) % 32) + ((z % 32 + 32) % 32) * 32) * 4);
    record.writeUInt32BE(packed.length + 1); record[4] = 2; packed.copy(record, 5); records.push(record); sector += sectors;
  }
  const region = path.join(root, 'dimensions/minecraft/overworld/region/r.-2.-1.mca');
  fs.writeFileSync(region, Buffer.concat([header, ...records]));
  const world = inspectWorld(root);
  return { root, region, world, dimension: world.dimensions[0].key };
}
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('nine mixed-version chunks preview; same-version export preserves exact states and raw records despite missing visuals', t => {
  const f = nineChunkWorld(t), before = hash(f.region), metadataBefore = hash(path.join(f.root, 'level.dat'));
  const volume = captureVolume(f.world, f.dimension, bounds);
  assert.equal(volume.complete, true); assert.deepEqual(volume.issues, []);
  assert.equal(volume.stats.total, 884736); assert.equal(volume.stats.unknown, 0);
  assert.equal(volume.stats.air, 442368); assert.equal(volume.stats.nonAir, 442368);
  assert.deepEqual(volumeBlock(volume, -655, -64, -176), unfamiliar);
  const archive = captureBuildArchive(f.world, f.dimension, { ...bounds, maxX: -641, maxZ: -161, maxY: -49 });
  const opened = validateBuildArchive(archive);
  assert.ok(opened.volume.palette.some(p => p && stateKey(p) === stateKey(unfamiliar)));
  assert.equal(opened.volume.complete, true);
  const expectedPalette = structuredClone(opened.volume.palette);
  for (const state of opened.volume.palette.filter(Boolean)) resolveModel({ json: () => null }, state);
  assert.deepEqual(opened.volume.palette, expectedPalette, 'Visual fallback must not mutate export data');
  const file = path.join(path.dirname(f.root), 'exact-states.wrbuild');
  saveBuildFile(file, archive, [f.root]);
  const restored = readBuildFile(file);
  assert.deepEqual(restored.volume.palette, expectedPalette);
  assert.deepEqual(restored.volume.voxels, opened.volume.voxels);
  const raw = createChunkReader(f.root, f.world.dimensions[0]).read(-41, -11).raw;
  assert.deepEqual(restored.decoded.get('region:-41,-11').raw, raw, 'Export must retain original binary wrappers and properties byte-for-byte');
  for (let i = 0; i < restored.volume.voxels.length; i++) {
    assert.deepEqual(restored.volume.palette[restored.volume.voxels[i]], i % 2 ? unfamiliar : { Name: 'minecraft:air' });
  }
  assert.throws(() => captureBuildArchive(f.world, f.dimension, bounds), /inconsistent DataVersions/, 'Preview support must not authorize a mixed-version export');
  assert.equal(hash(f.region), before); assert.equal(hash(path.join(f.root, 'level.dat')), metadataBefore);
});

test('malformed wrapper leaves the entire chunk unknown and blocks archive capture', t => {
  const f = nineChunkWorld(t, true), before = hash(f.region), volume = captureVolume(f.world, f.dimension, bounds);
  assert.equal(volume.complete, false); assert.equal(volume.stats.unknown, 98304);
  assert.equal(volume.stats.air + volume.stats.nonAir, 8 * 98304);
  assert.match(volume.issues.join(' '), /Invalid compact block-state wrapper/);
  assert.throws(() => captureBuildArchive(f.world, f.dimension, bounds), /complete/);
  assert.equal(hash(f.region), before);
});
