import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeSection, isAir } from '../engine/chunks.js';
import { createTerrainReader, projectTerrain, terrainOptions } from '../engine/terrain.js';
import { terrainColor } from '../engine/terrain-colors.js';
import { inspectWorld } from '../engine/world.js';
import { parseNBT } from '../engine/nbt.js';
import { nbt } from './fixtures.js';
import { makeBlockWorld, sectionFixture, state } from './transfer-fixtures.js';

const metadata = { version: '26.3', dataVersion: 5023, versionId: 5023, snapshot: false };
const overworld = { id: 'minecraft:overworld' }, nether = { id: 'minecraft:the_nether' };
function chunk(block, dimension = overworld) {
  const start = dimension === overworld ? -4 : 0, count = dimension === overworld ? 24 : 16;
  return parseNBT(nbt({ DataVersion: [3, 5023], sections: [9, { type: 10, values: Array.from({ length: count }, (_, i) => sectionFixture(start + i, block)) }] }));
}

// Independent scalar oracle: the original column-first scan, including its
// three-consecutive-air cavern rule and row-major color-palette construction.
function scalarProjection(data, options) {
  const sections = new Map(data.sections.filter(s => s.Y >= Math.floor(options.minY / 16) && s.Y <= Math.floor(options.maxY / 16)).map(s => [s.Y, decodeSection(s)]));
  const heights = new Int16Array(256).fill(-32768), ids = new Uint16Array(256), palette = [''];
  let fallbackColumns = 0;
  for (let i = 0; i < 256; i++) {
    let air = 0;
    for (let y = options.maxY; y >= options.minY; y--) {
      const section = sections.get(Math.floor(y / 16)), block = section.palette[section.indices[((y % 16 + 16) % 16) * 256 + i]];
      if (isAir(block)) { air++; continue; }
      if (options.mode === 'caverns' && air < 3) { air = 0; continue; }
      heights[i] = y;
      if (!palette.includes(block.Name)) palette.push(block.Name);
      ids[i] = palette.indexOf(block.Name);
      if (terrainColor(block.Name).approximate) fallbackColumns++;
      break;
    }
  }
  const rgba = new Uint8ClampedArray(1024);
  for (let i = 0; i < 256; i++) {
    const north = i >= 16 && ids[i - 16] ? heights[i - 16] : heights[i];
    const shade = Math.max(.65, Math.min(1.2, .93 + (heights[i] - north) * .035 + (heights[i] - 64) * .0006));
    const color = ids[i] ? terrainColor(palette[ids[i]]).rgb : options.mode === 'caverns' ? 0x39464f : 0x162831;
    for (let c = 0; c < 3; c++) rgba[i * 4 + c] = Math.min(255, ((color >> (16 - 8 * c)) & 255) * (ids[i] ? shade : 1));
    rgba[i * 4 + 3] = 255;
  }
  return { heights, ids, palette, rgba, fallbackColumns };
}

test('section skipping retains exact scalar heights, row-major palettes, relief and unknown-material colors', () => {
  const fixtures = [
    chunk((_x, y) => state(y % 3 === 0 ? 'air' : y % 3 === 1 ? 'cave_air' : 'void_air')),
    chunk((_x, y) => state(y <= 64 ? 'stone' : 'air')),
    chunk((x, y, z) => ({ Name: y <= x * 3 + z - 64 ? `example:terrain_${(x + z) % 5}` : y === 90 && x === 8 ? 'minecraft:oak_stairs' : 'minecraft:air' })),
    chunk((x, y, z) => state((x + y + z) % 7 === 0 ? 'air' : (x * 5 + y + z) % 3 === 0 ? 'dirt' : 'stone'))
  ];
  for (const data of fixtures) for (const request of [{}, { mode: 'cutaway', y: -64 }, { mode: 'cutaway', y: -1 }, { mode: 'cutaway', y: 16 }, { mode: 'cutaway', y: 65 }, { mode: 'cutaway', y: 318 }]) {
    const before = structuredClone(data), options = terrainOptions(metadata, overworld, request), result = projectTerrain(data, options, overworld.id), expected = scalarProjection(data, options);
    for (const key of Object.keys(expected)) assert.deepEqual(result[key], expected[key], `${request.mode ?? 'surface'}:${request.y ?? 'all'}:${key}`);
    assert.deepEqual(structuredClone(data), before);
  }
});

test('Nether cavern runs survive section edges, short cavities, roof mode and partial cut heights', () => {
  const data = chunk((x, y) => state(y >= 110 && y <= 127 ? 'bedrock' :
    y === 140 ? 'quartz_block' : y <= 40 ? 'lava' :
      x < 4 && y >= 94 && y <= 96 ? 'netherrack' : x < 8 && y >= 91 && y <= 95 ? 'netherrack' :
        x < 12 && y >= 80 && y <= 91 ? 'netherrack' : y >= 99 && y <= 103 ? 'netherrack' : 'air'), nether);
  for (const request of [{}, { mode: 'roof' }, { mode: 'surface' }, { mode: 'cutaway', y: 95 }, { mode: 'cutaway', y: 0 }]) {
    const options = terrainOptions(metadata, nether, request), result = projectTerrain(data, options, nether.id), expected = scalarProjection(data, options);
    for (const key of Object.keys(expected)) assert.deepEqual(result[key], expected[key]);
  }
});

test('a visible solid roof never short-circuits hidden palette, data or missing-section validation', () => {
  const options = terrainOptions(metadata, overworld);
  for (const [patch, code] of [
    [s => { s.block_states.palette = [{ Name: 'minecraft:air', Properties: { wrong: 3 } }]; }, 'BLOCK_STATE'],
    [s => { s.block_states.data = ['0']; }, 'BLOCK_DATA'],
    [s => { s.block_states = { palette: [state('air'), state('stone')], data: Array(256).fill('-1') }; }, 'BLOCK_INDEX'],
    [s => { s.block_states = undefined; }, 'TERRAIN_SECTION_MISSING']
  ]) {
    const data = chunk((_x, y) => state(y === 319 ? 'stone' : 'air')); patch(data.sections[0]);
    assert.throws(() => projectTerrain(data, options, overworld.id), { code });
  }
});

test('reader phase metrics count actual decode/projection and stay unchanged on pixel cache hits', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-fast-terrain-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  makeBlockWorld(root, { dataVersion: 5023, sections: Array.from({ length: 24 }, (_, i) => i - 4), block: (_x, y) => state(y < 64 ? 'stone' : 'air') });
  const world = inspectWorld(root), reader = createTerrainReader(world), request = { dimension: world.dimensions[0].key, chunks: [{ x: 0, z: 0 }] };
  const cold = reader.batch(request), warm = reader.batch(request);
  assert.ok(Number.isFinite(cold.readMs) && cold.readMs > 0); assert.ok(Number.isFinite(cold.projectMs) && cold.projectMs > 0);
  assert.equal(warm.readMs, cold.readMs); assert.equal(warm.projectMs, cold.projectMs); assert.equal(warm.readAttempts, 1); assert.equal(warm.memoryHits, 1);
});
