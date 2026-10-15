import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { nbt, writeDat, makeWorld } from './fixtures.js';
import { uuidString } from '../engine/players.js';

export const playerIds = [[1, 2, 3, 4], [-1, -2, -3, -4]];
export const playerPath = (i = 0) => `players/data/${uuidString(playerIds[i])}.dat`;
export const spawnTag = (pos = [8, 65, 8], dimension = 'minecraft:overworld') => [10, { dimension: [8, dimension], pos: [11, pos], yaw: [5, 0], pitch: [5, 0] }];
export function playerTags(i = 0, overrides = {}) {
  return { DataVersion: [3, 5023], UUID: [11, playerIds[i]], Dimension: [8, 'minecraft:overworld'],
    Pos: [9, { type: 6, values: [8.5, 65, 8.5] }], respawn: spawnTag(),
    Inventory: [9, { type: 10, values: [{ Slot: [1, 0], id: [8, 'minecraft:diamond'], count: [3, 17] }] }],
    EnderItems: [9, { type: 10, values: [{ Slot: [1, 2], id: [8, 'minecraft:ender_pearl'], count: [3, 8] }] }],
    XpLevel: [3, 42], XpTotal: [3, 3000], ...overrides };
}
export function levelTags(overrides = {}) {
  return { Data: [10, { LevelName: [8, 'Disposable preservation fixture — NOT playable'], DataVersion: [3, 5023],
    Version: [10, { Name: [8, '26.3'], Id: [3, 5023], Snapshot: [1, 0] }], spawn: spawnTag(),
    singleplayer_uuid: [11, playerIds[0]], ...overrides }] };
}
function region(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = Buffer.alloc(8192), sectors = []; let offset = 2;
  for (const { x, tags } of records) {
    const payload = deflateSync(nbt(tags)), count = Math.ceil((payload.length + 5) / 4096), sector = Buffer.alloc(count * 4096);
    header.writeUInt32BE(offset * 256 + count, x * 4); header.writeUInt32BE(1234, 4096 + x * 4);
    sector.writeUInt32BE(payload.length + 1); sector[4] = 2; payload.copy(sector, 5); sectors.push(sector); offset += count;
  }
  fs.writeFileSync(file, Buffer.concat([header, ...sectors]));
}
/** Generated format fixture only: block platform, chest inventory, villager, POI and two player accounts. */
export function preservationWorld(root) {
  makeWorld(root, { dataVersion: 5023 }); writeDat(path.join(root, 'level.dat'), levelTags());
  for (const [i] of playerIds.entries()) {
    writeDat(path.join(root, playerPath(i)), playerTags(i, i === 1 ? { Dimension: [8, 'minecraft:the_end'], respawn: spawnTag([8, 65, 8], 'minecraft:the_end') } : {}));
    for (const folder of ['players/stats', 'players/advancements']) {
      fs.mkdirSync(path.join(root, folder), { recursive: true });
      fs.writeFileSync(path.join(root, folder, `${uuidString(playerIds[i])}.json`), JSON.stringify({ fixture: true, progress: 150 + i }));
    }
  }
  for (const store of ['region', 'entities', 'poi']) region(path.join(root, `dimensions/minecraft/overworld/${store}/r.0.0.mca`), [0, 4].map(x => ({ x,
    tags: store === 'region' ? { DataVersion: [3, 5023], xPos: [3, x], zPos: [3, 0], Status: [8, 'minecraft:full'],
      sections: [9, { type: 10, values: [{ Y: [1, 4], block_states: [10, { palette: [9, { type: 10, values: [{ id: [8, 'minecraft:oak_planks'] }] }] }] }] }],
      block_entities: [9, { type: 10, values: [{ id: [8, 'minecraft:chest'], x: [3, x * 16 + 1], y: [3, 65], z: [3, 1], Items: playerTags().Inventory }] }] }
      : store === 'entities' ? { DataVersion: [3, 5023], Position: [11, [x, 0]], Entities: [9, { type: 10, values: [{ id: [8, 'minecraft:villager'], UUID: [11, [20, 21, 22, x]], Pos: [9, { type: 6, values: [x * 16 + 8, 65, 8] }] }] }] }
      : { DataVersion: [3, 5023], Sections: [10, { 4: [10, { Valid: [1, 1], Records: [9, { type: 10, values: [{ pos: [11, [x * 16 + 8, 65, 8]], type: [8, 'minecraft:home'], free_tickets: [3, 1] }] }] }] }] }
  })));
  return root;
}
