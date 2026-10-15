import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { nbt, writeDat } from '../tests/fixtures.js';
import { sectionFixture, state } from '../tests/transfer-fixtures.js';

export const dimensions = ['overworld', 'the_nether', 'the_end'];
export const dimPath = d => `dimensions/minecraft/${d}`;
export const playerIds = [
  '00000001-0000-0002-0000-000300000004',
  '00000005-0000-0006-0000-000700000008',
  '00000009-0000-000a-0000-000b0000000c'
];
export const list = values => [9, { type: 10, values }];
export const slot = (x, z) => ((x % 32 + 32) % 32) + 32 * ((z % 32 + 32) % 32);
export const regionPath = (d, store, x = 0, z = 0) => `${dimPath(d)}/${store}/r.${Math.floor(x / 32)}.${Math.floor(z / 32)}.mca`;

/** Test-only writer; rejects existing targets. Never accepts a live-save path. */
export function writeRecords(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = Buffer.alloc(8192), bodies = []; let offset = 2;
  for (const { x, z, tags } of records) {
    const compressed = deflateSync(nbt(tags));
    const count = Math.ceil((compressed.length + 5) / 4096), body = Buffer.alloc(count * 4096), i = slot(x, z);
    if (header.readUInt32BE(i * 4)) throw new Error('Duplicate fixture record');
    header.writeUInt32BE(offset * 256 + count, i * 4); header.writeUInt32BE(1700000000 + i, 4096 + i * 4);
    body.writeUInt32BE(compressed.length + 1); body[4] = 2; compressed.copy(body, 5);
    bodies.push(body); offset += count;
  }
  fs.writeFileSync(file, Buffer.concat([header, ...bodies]), { flag: 'wx' });
}
function section(y, block, modern) {
  const result = sectionFixture(y, block);
  if (modern) for (const p of result.block_states[1].palette[1].values) {
    p.id = p.Name; delete p.Name;
    if (p.Properties) { p.properties = p.Properties; delete p.Properties; }
  }
  return result;
}
export function terrainTags(x, z, block, { modern = true, ys = [4], attachments = [], dataVersion = 5023 } = {}) {
  return { DataVersion: [3, dataVersion], xPos: [3, x], zPos: [3, z], Status: [8, 'minecraft:full'],
    sections: list(ys.map(y => section(y, (lx, yy, lz) => block(x * 16 + lx, yy, z * 16 + lz), modern))),
    block_entities: list(attachments), block_ticks: list([]), fluid_ticks: list([]) };
}
const items = list([{ Slot: [1, 0], id: [8, 'minecraft:diamond'], count: [3, 17] }]);
const spawn = (dimension, pos) => [10, { dimension: [8, `minecraft:${dimension}`], pos: [11, pos], yaw: [5, 0], pitch: [5, 0] }];
function blockFor(d, x, y, z) {
  if (d === 'the_nether') {
    if (y === 127) return state(x === 3 && z === 3 ? 'air' : 'bedrock');
    if (y === 126 && x === 3 && z === 3) return state('ladder', { facing: 'north', waterlogged: 'false' });
    if (y === 128) return state(x === 3 && z === 3 ? 'air' : 'stone_bricks');
    if (y === 129 && x === 1 && z === 1) return state('nether_portal', { axis: 'x' });
  }
  if (y === 64) return state(d === 'the_end' ? 'end_stone' : 'oak_planks');
  if (y === 65 && z === 2 && x >= 2 && x <= 6) return state(['hopper', 'chest', 'rail', 'red_bed', 'comparator'][x - 2]);
  if (y === 65 && x === 8 && z === 8) return state(d === 'the_end' ? 'end_gateway' : d === 'overworld' ? 'nether_portal' : 'air');
  return state('air');
}
/** Disposable NBT/Anvil fixture, NOT a game-generated or playable world. */
export function createFixture(root, { modern = true, seed = 12345n, dataVersion = 5023 } = {}) {
  fs.mkdirSync(root); // Must be a newly-owned directory, not an existing world.
  writeDat(path.join(root, 'level.dat'), { Data: [10, {
    LevelName: [8, 'WorldRenew QA — synthetic, NOT playable'], DataVersion: [3, dataVersion],
    Version: [10, { Name: [8, '26.3'], Id: [3, dataVersion], Snapshot: [1, 0] }], spawn: spawn('overworld', [8, 65, 8])
  }] });
  writeDat(path.join(root, 'data/minecraft/world_gen_settings.dat'), { data: [10, { seed: [4, seed] }] });
  for (const [i, d] of dimensions.entries()) {
    const y = d === 'the_nether' ? 130 : 65;
    writeDat(path.join(root, `players/data/${playerIds[i]}.dat`), {
      DataVersion: [3, dataVersion], UUID: [11, [1, 2, 3, 4].map(n => n + i * 4)],
      Dimension: [8, `minecraft:${d}`], Pos: [9, { type: 6, values: [8.5, y, 8.5] }],
      respawn: spawn(d, [8, y, 8]), Inventory: items, EnderItems: items, XpLevel: [3, 42]
    });
    for (const folder of ['stats', 'advancements']) {
      fs.mkdirSync(path.join(root, `players/${folder}`), { recursive: true });
      fs.writeFileSync(path.join(root, `players/${folder}/${playerIds[i]}.json`), JSON.stringify({ fixtureOnly: true, value: i }));
    }
    const chunks = [[0, 0], [1, 0], [4, 0], [-1, -1], [31, 0], [32, 0], ...(d === 'the_end' ? [[6, 0]] : [])];
    for (const store of ['region', 'entities', 'poi']) {
      const groups = new Map();
      for (const [x, z] of chunks) {
        const attachment = d === 'the_end'
          ? { id: [8, 'minecraft:end_gateway'], x: [3, 8], y: [3, 65], z: [3, 8], ExitPortal: [10, { X: [3, 104], Y: [3, 75], Z: [3, 8] }], ExactTeleport: [1, 1] }
          : { id: [8, 'minecraft:chest'], x: [3, 3], y: [3, 65], z: [3, 2], Items: items };
        const tags = store === 'region' ? terrainTags(x, z, (xx, yy, zz) => blockFor(d, xx, yy, zz), { modern, ys: d === 'the_nether' ? [4, 7, 8] : [4], attachments: x === 0 && z === 0 ? [attachment] : [], dataVersion })
          : store === 'entities' ? { DataVersion: [3, dataVersion], Position: [11, [x, z]], Entities: list(x === 4 ? [] : [{ id: [8, d === 'the_end' ? 'minecraft:endermite' : 'minecraft:villager'], UUID: [11, [20 + i, 21, x, z]], Pos: [9, { type: 6, values: [x * 16 + 8.5, y, z * 16 + 8.5] }] }]) }
          : { DataVersion: [3, dataVersion], Sections: [10, { 4: [10, { Valid: [1, 1], Records: list([{ pos: [11, [x * 16 + 5, 65, z * 16 + 2]], type: [8, 'minecraft:home'], free_tickets: [3, 1] }]) }] }] };
        const file = regionPath(d, store, x, z); if (!groups.has(file)) groups.set(file, []);
        groups.get(file).push({ x, z, tags });
      }
      for (const [file, records] of groups) writeRecords(path.join(root, file), records);
    }
  }
  writeDat(path.join(root, 'dimensions/minecraft/the_end/data/minecraft/dragon_fight.dat'), { data: [10, { fixtureOnly: [1, 1], Gateways: [11, [1, 3, 5]] }] });
  return root;
}
