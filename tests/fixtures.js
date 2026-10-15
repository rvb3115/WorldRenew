import fs from 'node:fs';
import path from 'node:path';
import { gzipSync, deflateSync } from 'node:zlib';

const sized = (size, value, method) => { const buffer = Buffer.alloc(size); buffer[method](value); return buffer; };
export const i32 = n => sized(4, n, 'writeInt32BE');
export function mutf8(value) {
  const bytes = [];
  for (let i = 0; i < value.length; i++) { const n = value.charCodeAt(i); if (n > 0 && n < 128) bytes.push(n); else if (n < 2048) bytes.push(0xc0 | n >> 6, 0x80 | n & 63); else bytes.push(0xe0 | n >> 12, 0x80 | n >> 6 & 63, 0x80 | n & 63); }
  return Buffer.concat([sized(2, bytes.length, 'writeUInt16BE'), Buffer.from(bytes)]);
}
export function payload(type, value) {
  switch (type) {
    case 1: return sized(1, value, 'writeInt8');
    case 2: return sized(2, value, 'writeInt16BE');
    case 3: return i32(value);
    case 4: return sized(8, BigInt(value), 'writeBigInt64BE');
    case 5: return sized(4, value, 'writeFloatBE');
    case 6: return sized(8, value, 'writeDoubleBE');
    case 7: return Buffer.concat([i32(value.length), Buffer.from(value)]);
    case 8: return mutf8(value);
    case 9: return Buffer.concat([Buffer.from([value.type]), i32(value.values.length), ...value.values.map(v => payload(value.type, v))]);
    case 10: return Buffer.concat([...Object.entries(value).map(([name, [t, v]]) => tag(t, name, v)), Buffer.from([0])]);
    case 11: return Buffer.concat([i32(value.length), ...value.map(i32)]);
    case 12: return Buffer.concat([i32(value.length), ...value.map(v => payload(4, v))]);
    default: throw new Error('Bad fixture tag');
  }
}
export function tag(type, name, value) { return Buffer.concat([Buffer.from([type]), mutf8(name), payload(type, value)]); }
export const nbt = values => tag(10, '', values);
export function writeDat(file, values) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, gzipSync(nbt(values))); }
export function emptyRecordTags(x, z, store = 'region') {
  return store === 'entities'
    ? { DataVersion:[3,5023], Position:[11,[x,z]], Entities:[9,{type:10,values:[]}] }
    : store === 'poi' ? { DataVersion:[3,5023], Sections:[10,{}] }
    : { DataVersion:[3,5023], xPos:[3,x], zPos:[3,z], Status:[8,'minecraft:full'], sections:[9,{type:10,values:[]}], block_entities:[9,{type:10,values:[]}], block_ticks:[9,{type:10,values:[]}], fluid_ticks:[9,{type:10,values:[]}] };
}

export function writeRegion(file, entries = [{ x: 0, z: 0 }]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buffer = Buffer.alloc((2 + entries.length) * 4096);
  entries.forEach((c, index) => {
    const slot = ((c.x % 32 + 32) % 32) + ((c.z % 32 + 32) % 32) * 32, sector = index + 2;
    buffer.writeUInt32BE((sector << 8) | 1, slot * 4); buffer.writeUInt32BE(1800000000, 4096 + slot * 4);
    const data = deflateSync(nbt(c.tags ?? emptyRecordTags(c.x, c.z, path.basename(path.dirname(file)))));
    buffer.writeUInt32BE(data.length + 1, sector * 4096); buffer[sector * 4096 + 4] = 2; data.copy(buffer, sector * 4096 + 5);
  });
  fs.writeFileSync(file, buffer); return buffer;
}
/** Synthetic format fixture, deliberately not a Minecraft-playable world. */
export function makeWorld(root, { legacy = false, version = '26.3', demo = false, dataVersion = 999999, spawn = [0, 64, 0] } = {}) {
  fs.mkdirSync(root, { recursive: true });
  const data = {
    LevelName: [8, demo ? 'Cedar Valley · synthetic demo' : 'Test World 🌲'], DataVersion: [3, dataVersion],
    Version: [10, { Name: [8, version], Id: [3, dataVersion], Snapshot: [1, 0] }],
    LastPlayed: [4, 1790544000000n], GameType: [3, 0], SpawnX: [3, spawn[0]], SpawnY: [3, spawn[1]], SpawnZ: [3, spawn[2]]
  };
  if (legacy) data.WorldGenSettings = [10, { seed: [4, -9223372036854775807n] }];
  writeDat(path.join(root, 'level.dat'), { Data: [10, data] });
  if (!legacy) writeDat(path.join(root, 'data/minecraft/world_gen_settings.dat'), { data: [10, { seed: [4, -9223372036854775807n] }] });
  const overworld = legacy ? '' : 'dimensions/minecraft/overworld';
  if (demo) {
    const grouped = new Map();
    for (let z = -43; z <= 49; z++) for (let x = -61; x <= 66; x++) {
      const ellipse = (x * x / 3700) + (z * z / 1700);
      if (ellipse > 1 + .11 * Math.sin(x * .2) * Math.cos(z * .17) && !(Math.abs(z - x * .3) < 5 && x > 0)) continue;
      if (Math.hypot(x + 18, z - 7) < 6) continue;
      const k = `${Math.floor(x / 32)},${Math.floor(z / 32)}`; if (!grouped.has(k)) grouped.set(k, []); grouped.get(k).push({ x, z });
    }
    for (const [k, entries] of grouped) { const [rx, rz] = k.split(','); writeRegion(path.join(root, overworld, `region/r.${rx}.${rz}.mca`), entries); }
  } else {
    writeRegion(path.join(root, overworld, 'region/r.0.0.mca'), [{ x: 0, z: 0 }, { x: 1, z: 0 }]);
    writeRegion(path.join(root, overworld, 'region/r.-1.-1.mca'), [{ x: -1, z: -1 }]);
  }
  writeRegion(path.join(root, legacy ? 'DIM-1' : 'dimensions/minecraft/the_nether', 'region/r.0.0.mca'));
  writeRegion(path.join(root, legacy ? 'DIM1' : 'dimensions/minecraft/the_end', 'region/r.0.0.mca'));
  writeRegion(path.join(root, overworld, 'entities/r.0.0.mca'));
  writeRegion(path.join(root, overworld, 'poi/r.0.0.mca'));
  return root;
}
