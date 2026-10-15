import fs from 'node:fs';
import path from 'node:path';
import { deflateSync, gzipSync } from 'node:zlib';
import { nbt, writeDat } from './fixtures.js';

export const state = (name, properties) => ({ Name: name.startsWith('minecraft:') ? name : `minecraft:${name}`, ...(properties ? { Properties: properties } : {}) });
export function sectionFixture(y, block) {
  const palette = [], ids = [], lookup = new Map();
  for (let ly = 0; ly < 16; ly++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    const value = block(x, y * 16 + ly, z), key = JSON.stringify(value);
    if (!lookup.has(key)) { lookup.set(key, palette.length); palette.push(value); } ids.push(lookup.get(key));
  }
  const data = [], bits = Math.max(4, Math.ceil(Math.log2(palette.length))), per = Math.floor(64 / bits);
  if (palette.length > 1) for (let start = 0; start < ids.length; start += per) {
    let word = 0n; for (let offset = 0; offset < per && start + offset < ids.length; offset++) word |= BigInt(ids[start + offset]) << BigInt(offset * bits);
    data.push(BigInt.asIntN(64, word));
  }
  const entries = palette.map(p => ({ Name: [8, p.Name], ...(p.Properties ? { Properties: [10, Object.fromEntries(Object.entries(p.Properties).map(([k,v])=>[k,[8,v]]))] } : {}) }));
  return { Y: [1, y], block_states: [10, { palette: [9, { type: 10, values: entries }], ...(data.length ? { data: [12, data] } : {}) }] };
}
export function writeBlockChunk(file, { x = 0, z = 0, block = () => state('air'), compression = 2, external = false, sections = [-1, 0, 1], status = 'minecraft:full', blockEntities = [], dataVersion = 999999 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = nbt({ DataVersion: [3, dataVersion], xPos: [3, x], zPos: [3, z], Status: [8, status], sections: [9, { type: 10, values: sections.map(y => sectionFixture(y, block)) }], block_entities: [9, { type: 10, values: blockEntities }], block_ticks: [9, { type: 10, values: [] }], fluid_ticks: [9, { type: 10, values: [] }] });
  const payload = compression === 1 ? gzipSync(raw) : compression === 2 ? deflateSync(raw) : raw;
  const count = external ? 1 : Math.ceil((payload.length + 5) / 4096), buffer = Buffer.alloc((2 + count) * 4096);
  const slot = ((x % 32 + 32) % 32) + ((z % 32 + 32) % 32) * 32;
  buffer.writeUInt32BE((2 << 8) | count, slot * 4); buffer.writeUInt32BE(external ? 1 : payload.length + 1, 8192); buffer[8196] = compression | (external ? 128 : 0);
  if (external) fs.writeFileSync(path.join(path.dirname(file), `c.${x}.${z}.mcc`), payload); else payload.copy(buffer, 8197);
  fs.writeFileSync(file, buffer); return raw;
}
export function makeBlockWorld(root, options = {}) {
  writeDat(path.join(root, 'level.dat'), { Data: [10, { LevelName: [8, 'Build transfer fixture'], DataVersion: [3, options.dataVersion ?? 999999], Version: [10, { Name: [8, options.version ?? '26.3'], Id: [3, options.dataVersion ?? 999999], Snapshot: [1, 0] }] }] });
  const x = options.x ?? 0, z = options.z ?? 0;
  writeBlockChunk(path.join(root, `dimensions/minecraft/overworld/region/r.${Math.floor(x/32)}.${Math.floor(z/32)}.mca`), options);
  return root;
}
export function buildBlock(x, y, z) {
  if (y < 0) {
    if (x >= 4 && x <= 10 && z >= 4 && z <= 10 && y >= -5 && y <= -2) return state('cave_air');
    return state('stone');
  }
  if (y === 0 && x >= 3 && x <= 11 && z >= 3 && z <= 11) return state('oak_planks');
  if (y >= 1 && y <= 5 && ((x === 3 || x === 11) && z >= 3 && z <= 11 || (z === 3 || z === 11) && x >= 3 && x <= 11)) return state('glass');
  if (y === 6 && x >= 3 && x <= 11 && z >= 3 && z <= 11) return state('oak_stairs', { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: 'false' });
  if (y === 20 && x >= 4 && x <= 10 && z >= 4 && z <= 10) return state('quartz_block');
  return state('air');
}
