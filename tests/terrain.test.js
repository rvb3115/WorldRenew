import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createTerrainReader, projectTerrain, terrainOptions } from '../engine/terrain.js';
import { terrainSupport } from '../engine/terrain-policy.js';
import { terrainColor } from '../engine/terrain-colors.js';
import { inspectWorld } from '../engine/world.js';
import { parseNBT } from '../engine/nbt.js';
import { nbt } from './fixtures.js';
import { makeBlockWorld, sectionFixture, state, writeBlockChunk } from './transfer-fixtures.js';
const meta = { version: '26.3', dataVersion: 5023, versionId: 5023, snapshot: false };
const dim = { id: 'minecraft:overworld' };
const opts = terrainOptions(meta, dim);
function chunk(block, sections = Array.from({ length: 24 }, (_, i) => i - 4)) { return parseNBT(nbt({ DataVersion: [3, 5023], sections: [9, { type: 10, values: sections.map(y => sectionFixture(y, block)) }] })); }
function fixture(t, options = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'worldrenew-terrain-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = makeBlockWorld(path.join(base, 'world'), { dataVersion: 5023, sections: Array.from({ length: 24 }, (_, i) => i - 4), block: (_x, y) => state(y <= 64 ? 'grass_block' : 'air'), ...options });
  const world = inspectWorld(root); return { root, world, dimension: world.dimensions[0].key, file: path.join(root, 'dimensions/minecraft/overworld/region/r.0.0.mca') };
}
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
test('surface shows actual columns, air-skipping, water, building roofs and heights without modifying NBT', () => {
  const data = chunk((x, y, z) => state(x < 4 && y <= 62 ? 'water' : x >= 4 && y <= 64 + z ? 'grass_block' : x === 8 && y === 90 ? 'bricks' : 'air'));
  const before = structuredClone(data), tile = projectTerrain(data, opts, dim.id);
  assert.equal(tile.heights[0], 62); assert.equal(tile.palette[tile.ids[0]], 'minecraft:water');
  assert.equal(tile.heights[8], 90); assert.equal(tile.palette[tile.ids[8]], 'minecraft:bricks');
  assert.equal(tile.heights[16 * 15 + 15], 79);
  assert.notDeepEqual([...tile.rgba.slice(0, 3)], [...tile.rgba.slice(20, 23)]);
  assert.deepEqual(structuredClone(data), before);
});
test('complete air differs from unreadable/missing sections', () => {
  const empty = projectTerrain(chunk(() => state('air')), opts, dim.id);
  assert.equal(empty.status, 'ready'); assert.equal(empty.ids.every(n => n === 0), true);
  assert.throws(() => projectTerrain(chunk(() => state('air'), [0]), opts, dim.id), { code: 'TERRAIN_SECTION_MISSING' });
});
test('malformed palettes, duplicate sections and future chunk versions never become empty terrain', () => {
  const data = chunk(() => state('air')); data.sections[0].block_states.palette = [{ '': 'minecraft:air', id: 'minecraft:stone' }];
  assert.throws(() => projectTerrain(data, opts, dim.id), { code: 'BLOCK_STATE' });
  const duplicated = chunk(() => state('air')); duplicated.sections.push(duplicated.sections[0]);
  assert.throws(() => projectTerrain(duplicated, opts, dim.id), { code: 'SECTION_DUPLICATE' });
  const future = chunk(() => state('air')); future.DataVersion = 6000;
  assert.throws(() => projectTerrain(future, opts, dim.id), { code: 'TERRAIN_UNSUPPORTED' });
});
test('Nether cavern floor, roof and cutaway are distinct projections', () => {
  const d = { id: 'minecraft:the_nether' };
  const data = chunk((_x, y) => state(y === 127 ? 'bedrock' : y >= 110 && y <= 126 ? 'netherrack' : y === 140 ? 'quartz_block' : y <= 40 ? 'lava' : 'air'), Array.from({ length: 16 }, (_, i) => i));
  const cavern = projectTerrain(data, terrainOptions(meta, d), d.id);
  assert.equal(cavern.heights[0], 40); assert.equal(cavern.palette[cavern.ids[0]], 'minecraft:lava');
  assert.equal(projectTerrain(data, terrainOptions(meta, d, { mode: 'roof' }), d.id).heights[0], 140);
  assert.equal(projectTerrain(data, terrainOptions(meta, d, { mode: 'cutaway', y: 115 }), d.id).heights[0], 115);
});
test('End void and unfamiliar material remain explicitly distinguishable', () => {
  const d = { id: 'minecraft:the_end' }, data = chunk((x, y) => ({ Name: x < 4 && y === 62 ? 'example:strange' : 'minecraft:air' }), Array.from({ length: 16 }, (_, i) => i));
  const result = projectTerrain(data, terrainOptions(meta, d), d.id);
  assert.equal(result.fallbackColumns, 64); assert.equal(result.ids[8], 0); assert.equal(result.heights[0], 62);
  assert.equal(terrainColor('example:strange').approximate, true);
});
test('strict preview version and dimension gates do not infer future heights', () => {
  assert.equal(terrainSupport(meta, dim), null);
  for (const change of [{ snapshot: true }, { version: '26.4' }, { dataVersion: 999999 }, { versionId: 999999 }]) assert.ok(terrainSupport({ ...meta, ...change }, dim));
  assert.ok(terrainSupport(meta, { id: 'example:world' }));
  assert.throws(() => terrainOptions(meta, dim, { mode: 'roof' }), { code: 'TERRAIN_VIEW' });
  assert.throws(() => terrainOptions(meta, dim, { mode: 'cutaway', y: 320 }), { code: 'TERRAIN_VIEW' });
});
test('bounded read-only tile batches cache pixels, not raw chunks; negative and absent coordinates work', t => {
  const f = fixture(t), before = hash(f.file), reader = createTerrainReader(f.world, { cacheLimit: 2 });
  const request = { dimension: f.dimension, chunks: [{ x: 0, z: 0 }, { x: -1, z: -1 }] };
  const result = reader.batch(request);
  assert.equal(result.tiles[0].status, 'ready'); assert.equal(result.tiles[1].status, 'absent');
  assert.equal(reader.batch(request).tiles[0], result.tiles[0], 'unchanged storage reuses projected tile');
  reader.batch({ ...request, chunks: [{ x: 2, z: 2 }] }); assert.equal(reader.cacheSize, 2);
  assert.equal(hash(f.file), before);
  assert.throws(() => reader.batch({ ...request, chunks: Array(17).fill({ x: 0, z: 0 }) }), { code: 'TERRAIN_LIMIT' });
  assert.throws(() => reader.batch({ ...request, chunks: [{ x: 1.5, z: 0 }] }), { code: 'TERRAIN_COORDINATES' });
});
test('changed region invalidates cached tile, missing external payload is unreadable, metadata change blocks the session', t => {
  const f = fixture(t), reader = createTerrainReader(f.world), request = { dimension: f.dimension, chunks: [{ x: 0, z: 0 }] };
  assert.equal(reader.batch(request).tiles[0].status, 'ready');
  writeBlockChunk(f.file, { dataVersion: 5023, external: true });
  fs.unlinkSync(path.join(path.dirname(f.file), 'c.0.0.mcc'));
  const failed = reader.batch(request).tiles[0]; assert.equal(failed.status, 'unreadable');
  fs.appendFileSync(path.join(f.root, 'level.dat'), 'changed');
  assert.throws(() => reader.batch(request), { code: 'WORLD_CHANGED' });
});
test('unreadable region headers remain in the map index, and absent slots in damaged regions are not declared empty', t => {
  const f = fixture(t); fs.writeFileSync(f.file, Buffer.alloc(100));
  const world = inspectWorld(f.root); assert.equal(world.dimensions[0].unreadableRegions.length, 1);
  assert.equal(createTerrainReader(world).batch({ dimension: f.dimension, chunks: [{ x: 0, z: 0 }] }).tiles[0].status, 'unreadable');
  const g = fixture(t); const bytes = fs.readFileSync(g.file); bytes.writeUInt32BE(1, 4); fs.writeFileSync(g.file, bytes);
  const reader = createTerrainReader(inspectWorld(g.root));
  assert.equal(reader.batch({ dimension: g.dimension, chunks: [{ x: 2, z: 0 }] }).tiles[0].status, 'unreadable');
});
test('negative chunk location preserves block orientation and source bytes', t => {
  const f = fixture(t, { x: -1, z: -1, block: (x, y, z) => state(y <= x + z ? 'stone' : 'air') });
  const tile = createTerrainReader(f.world).batch({ dimension: f.dimension, chunks: [{ x: -1, z: -1 }] }).tiles[0];
  assert.equal(tile.status, 'ready'); assert.equal(tile.heights[0], 0); assert.equal(tile.heights[255], 30);
});
