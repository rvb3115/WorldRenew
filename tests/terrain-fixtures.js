import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { nbt, writeDat } from './fixtures.js';
import { sectionFixture, state } from './transfer-fixtures.js';

export function writeTerrainRegion(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = Buffer.alloc(8192), records = []; let sector = 2;
  for (const { x, z, block, sections = Array.from({ length: 24 }, (_, i) => i - 4), dataVersion = 5023, malformed = false } of entries) {
    const list = sections.map(y => sectionFixture(y, (lx, wy, lz) => block(x * 16 + lx, wy, z * 16 + lz)));
    if (malformed) list.at(-1).block_states = [10, { palette: [9, { type: 10, values: [{ '': [8, 'minecraft:air'], id: [8, 'minecraft:stone'] }] }] }];
    const raw = nbt({ DataVersion: [3, dataVersion], xPos: [3, x], zPos: [3, z], Status: [8, 'minecraft:full'], sections: [9, { type: 10, values: list }], block_entities: [9, { type: 10, values: [] }], block_ticks: [9, { type: 10, values: [] }], fluid_ticks: [9, { type: 10, values: [] }] });
    const compressed = deflateSync(raw), count = Math.ceil((compressed.length + 5) / 4096), record = Buffer.alloc(count * 4096);
    header.writeUInt32BE((sector << 8) | count, (((x % 32 + 32) % 32) + ((z % 32 + 32) % 32) * 32) * 4);
    record.writeUInt32BE(compressed.length + 1); record[4] = 2; compressed.copy(record, 5); records.push(record); sector += count;
  }
  fs.writeFileSync(file, Buffer.concat([header, ...records]));
}
export function landscape(x, y, z) {
  const river = Math.sin(z / 23) * 17 + 25;
  const hill = Math.max(0, Math.round(28 - Math.hypot((x - 70) * .65, z + 32) * .35));
  const ground = 62 + hill + Math.round(Math.sin(x / 19) * 2 + Math.cos(z / 15) * 2);
  if (Math.abs(x - river) < 9) return state(y <= 61 ? 'water' : 'air');
  if (Math.abs(x - river) < 12) return state(y <= 62 ? 'sand' : 'air');
  // Recognizable paths, red-roof buildings, stone courtyard and planted tree crowns.
  if (Math.abs(z - 35) < 2 || Math.abs(x + 34) < 2) return state(y <= ground ? 'dirt_path' : 'air');
  if (x >= -65 && x <= -43 && z >= 2 && z <= 24) {
    if (y === ground + 9) return state('red_terracotta');
    if (y <= ground || y <= ground + 8 && [x + 65, -43 - x, z - 2, 24 - z].some(n => n === 0)) return state('oak_planks');
    return state('air');
  }
  if (x < -40 && z < -18 && (x % 19 + 19) % 19 < 8 && (z % 21 + 21) % 21 < 8 && y > ground && y <= ground + 6) return state('oak_leaves');
  if (y > ground) return state('air');
  return state(y === ground ? hill > 23 ? 'snow_block' : hill > 18 ? 'stone' : 'grass_block' : 'stone');
}
export function makeTerrainWorld(root) {
  writeDat(path.join(root, 'level.dat'), { Data: [10, { LevelName: [8, 'Cedar River · terrain test fixture'], DataVersion: [3, 5023], Version: [10, { Name: [8, '26.3'], Id: [3, 5023], Snapshot: [1, 0] }], SpawnX: [3, -32], SpawnY: [3, 65], SpawnZ: [3, 32] }] });
  const grouped = new Map();
  for (let z = -4; z <= 4; z++) for (let x = -5; x <= 6; x++) {
    if (x === -1 && z === -1) continue;
    const k = `${Math.floor(x / 32)}.${Math.floor(z / 32)}`;
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push({ x, z, block: landscape, malformed: x === 6 && z === 4 });
  }
  for (const [k, entries] of grouped) writeTerrainRegion(path.join(root, `dimensions/minecraft/overworld/region/r.${k}.mca`), entries);
  const nether = (x, y, z) => state(y >= 124 && y <= 127 ? 'bedrock' : y >= 110 && y < 124 ? 'netherrack' : y === 140 && x < 8 ? 'quartz_block' : y <= 30 ? 'lava' : y <= 45 && x < 12 ? 'netherrack' : 'air');
  writeTerrainRegion(path.join(root, 'dimensions/minecraft/the_nether/region/r.0.0.mca'), [{ x: 0, z: 0, sections: Array.from({ length: 16 }, (_, i) => i), block: nether }]);
  writeTerrainRegion(path.join(root, 'dimensions/minecraft/the_end/region/r.0.0.mca'), [{ x: 0, z: 0, sections: Array.from({ length: 16 }, (_, i) => i), block: (x, y, z) => state(y < 65 && y > 50 && x < 9 ? 'end_stone' : 'air') }]);
  return root;
}
