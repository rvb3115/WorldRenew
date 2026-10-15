import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { nbt, tag, writeDat } from './fixtures.js';
import { sectionFixture, state } from './transfer-fixtures.js';

/** Generated parser/performance data only; deliberately not a playable Minecraft world. */
export function makeLargeOverviewWorld(root, { chunks = 2560, regions = Math.max(80, Math.ceil(chunks / 1024)), onProgress = () => {} } = {}) {
  if (!Number.isSafeInteger(chunks) || chunks < 1 || chunks > 1000000 || !Number.isSafeInteger(regions) || regions < 1 || regions > chunks || regions * 1024 < chunks) throw new Error('Invalid generated chunk/region count.');
  if (fs.existsSync(root)) throw new Error('Fixture root must not already exist.');
  fs.mkdirSync(root, { recursive: true });
  writeDat(path.join(root, 'level.dat'), { Data: [10, {
    LevelName: [8, 'Generated large overview benchmark — not playable'], DataVersion: [3, 5023],
    Version: [10, { Name: [8, '26.3'], Id: [3, 5023], Snapshot: [1, 0] }],
    SpawnX: [3, 0], SpawnY: [3, 80], SpawnZ: [3, 0]
  }] });
  writeDat(path.join(root, 'data/minecraft/world_gen_settings.dat'), { data: [10, { seed: [4, 42n] }] });
  // Construct four templates once. Each has all 24 vanilla sections, nine mixed
  // palettes below/at the surface and 15 valid single-air upper sections.
  const blueprints = Array.from({ length: 4 }, (_, variant) => {
    const sections = Array.from({ length: 24 }, (_, i) => sectionFixture(i - 4, (x, y, z) => {
      const height = 65 + ((x + z * 3 + variant * 2) % 13);
      if (y > height) return state('air');
      if (y === height) return state(variant === 3 ? 'sand' : 'grass_block');
      if (y > height - 3) return state('dirt');
      if ((x * 3 + z * 5 + y + 1024) % 23 < 2) return state('cave_air');
      return state((x + z + y + 1024) % 17 === 0 ? 'coal_ore' : y < 0 ? 'deepslate' : 'stone');
    }));
    const raw = nbt({ DataVersion: [3, 5023], xPos: [3, 0], zPos: [3, 0], Status: [8, 'minecraft:full'], sections: [9, { type: 10, values: sections }], block_entities: [9, { type: 10, values: [] }], block_ticks: [9, { type: 10, values: [] }], fluid_ticks: [9, { type: 10, values: [] }] });
    const offset = key => { const needle = tag(3, key, 0), start = raw.indexOf(needle); if (start < 0 || raw.indexOf(needle, start + 1) !== -1) throw new Error('Ambiguous coordinate fixture tag.'); return start + needle.length - 4; };
    return { raw, xOffset: offset('xPos'), zOffset: offset('zPos') };
  });
  const directory = path.join(root, 'dimensions/minecraft/overworld/region');
  fs.mkdirSync(directory, { recursive: true });
  const width = Math.ceil(Math.sqrt(regions)); let generated = 0, logicalBytes = 0, payloadBytes = 0;
  const started = performance.now();
  for (let r = 0; r < regions; r++) {
    const rx = r % width - Math.floor(width / 2), rz = Math.floor(r / width) - Math.floor(width / 2);
    const count = Math.floor(chunks / regions) + (r < chunks % regions ? 1 : 0), header = Buffer.alloc(8192);
    const file = path.join(directory, `r.${rx}.${rz}.mca`), fd = fs.openSync(file, 'wx'); let sector = 2;
    try {
      for (let slot = 0; slot < count; slot++) {
        const x = rx * 32 + slot % 32, z = rz * 32 + Math.floor(slot / 32), blueprint = blueprints[(r + slot) % blueprints.length];
        blueprint.raw.writeInt32BE(x, blueprint.xOffset); blueprint.raw.writeInt32BE(z, blueprint.zOffset);
        const compressed = deflateSync(blueprint.raw, { level: 1 }), sectors = Math.ceil((compressed.length + 5) / 4096), record = Buffer.alloc(compressed.length + 5);
        if (sectors > 255) throw new Error('Fixture exceeds an internal Anvil record.');
        record.writeUInt32BE(compressed.length + 1); record[4] = 2; compressed.copy(record, 5);
        header.writeUInt32BE((sector << 8) | sectors, slot * 4); header.writeUInt32BE(1800000000, 4096 + slot * 4);
        fs.writeSync(fd, record, 0, record.length, sector * 4096); sector += sectors; payloadBytes += record.length; generated++;
      }
      fs.writeSync(fd, header, 0, header.length, 0); fs.ftruncateSync(fd, sector * 4096); logicalBytes += sector * 4096;
    } finally { fs.closeSync(fd); }
    if ((r + 1) % 16 === 0 || r + 1 === regions) onProgress({ regions: r + 1, chunks: generated, seconds: (performance.now() - started) / 1000 });
  }
  const manifest = { schema: 1, generatedOnly: true, playable: false, root, chunks: generated, regions, dataVersion: 5023, version: '26.3', sectionsPerChunk: 24, mixedSectionsPerChunk: 9, singleAirSectionsPerChunk: 15, distinctCoordinates: true, terrainVariants: blueprints.length, rawBytesPerChunk: blueprints.map(b => b.raw.length), logicalRegionBytes: logicalBytes, compressedRecordBytes: payloadBytes, generationSeconds: (performance.now() - started) / 1000 };
  fs.writeFileSync(path.join(root, 'benchmark-fixture.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** Stable historical order, independent of later UI queue implementation. */
export function* legacyOverviewOrder(regions) {
  const longest = Math.max(0, ...regions.map(r => r.chunks.length));
  for (let slot = 0; slot < longest; slot++) for (const region of regions) if (slot < region.chunks.length) yield region.chunks[slot];
}
export function* localOverviewOrder(regions) { for (const region of regions) yield* region.chunks; }
