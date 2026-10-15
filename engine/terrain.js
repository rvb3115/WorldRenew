import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createChunkReader, decodeSection, isAir } from './chunks.js';
import { canonicalWorld, readBounded, safePath } from './paths.js';
import { requireThat } from './errors.js';
import { terrainColor } from './terrain-colors.js';
import { terrainSupport, terrainHeights, TERRAIN_BATCH_LIMIT, TERRAIN_CACHE_LIMIT } from './terrain-policy.js';

export function terrainOptions(metadata, dimension, request = {}) {
  const reason = terrainSupport(metadata, dimension);
  requireThat(!reason, 'TERRAIN_UNSUPPORTED', reason);
  const heights = terrainHeights[dimension.id], mode = request.mode ?? (dimension.id === 'minecraft:the_nether' ? 'caverns' : 'surface');
  requireThat(['surface', 'caverns', 'roof', 'cutaway'].includes(mode), 'TERRAIN_VIEW', 'Unknown terrain view.');
  requireThat(!['caverns', 'roof'].includes(mode) || dimension.id === 'minecraft:the_nether', 'TERRAIN_VIEW', 'Roof and cavern views are Nether-only.');
  let { minY, maxY } = heights;
  if (mode === 'caverns') maxY = 127;
  if (mode === 'roof') minY = 128;
  if (mode === 'cutaway') {
    requireThat(Number.isInteger(request.y) && request.y >= minY && request.y <= maxY, 'TERRAIN_VIEW', `Choose a cutaway height from ${minY} to ${maxY}.`);
    maxY = request.y;
  }
  return { mode, minY, maxY };
}

/** A 16×16 tile derived from disk block states. No world or NBT data is mutated. */
export function projectTerrain(nbt, options, dimensionId) {
  requireThat([4903, 5023].includes(nbt.DataVersion), 'TERRAIN_UNSUPPORTED', 'Chunk DataVersion is unsupported; terrain was not inferred.');
  const heights = terrainHeights[dimensionId], sections = new Map();
  requireThat(Array.isArray(nbt.sections) && nbt.sections.length <= 32, 'TERRAIN_SECTIONS', 'Unsupported section list.');
  for (const section of nbt.sections) {
    requireThat(Number.isInteger(section.Y) && !sections.has(section.Y), 'SECTION_DUPLICATE', 'Missing or duplicate section Y.');
    if (section.block_states) requireThat(section.Y >= Math.floor(heights.minY / 16) && section.Y <= Math.floor(heights.maxY / 16), 'TERRAIN_UNSUPPORTED', 'Custom dimension height is unsupported.');
    // Validate every supplied palette in the selected height range, even below a visible surface.
    sections.set(section.Y, section.block_states && section.Y >= Math.floor(options.minY / 16) && section.Y <= Math.floor(options.maxY / 16) ? decodeSection(section) : null);
  }
  for (let sy = Math.floor(options.minY / 16); sy <= Math.floor(options.maxY / 16); sy++)
    requireThat(sections.get(sy), 'TERRAIN_SECTION_MISSING', `Section Y ${sy} is missing block data. Unknown terrain is not air.`);
  const top = new Int16Array(256).fill(-32768), ids = new Uint16Array(256), palette = [''], paletteIds = new Map();
  let fallbackColumns = 0;
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    let airRun = 0;
    for (let y = options.maxY; y >= options.minY; y--) {
      const s = sections.get(Math.floor(y / 16)), state = s.palette[s.indices[((y % 16 + 16) % 16) * 256 + z * 16 + x]];
      if (isAir(state)) { airRun++; continue; }
      if (options.mode === 'caverns' && airRun < 3) { airRun = 0; continue; }
      const i = z * 16 + x;
      top[i] = y;
      if (!paletteIds.has(state.Name)) { paletteIds.set(state.Name, palette.length); palette.push(state.Name); }
      ids[i] = paletteIds.get(state.Name);
      if (terrainColor(state.Name).approximate) fallbackColumns++;
      break;
    }
  }
  const rgba = new Uint8ClampedArray(1024);
  for (let i = 0; i < 256; i++) {
    const { rgb } = terrainColor(palette[ids[i]]);
    // North-facing relief and absolute elevation; deterministic at chunk boundaries.
    const north = i >= 16 && ids[i - 16] ? top[i - 16] : top[i];
    const shade = Math.max(.65, Math.min(1.2, .93 + (top[i] - north) * .035 + (top[i] - 64) * .0006));
    const color = ids[i] ? rgb : options.mode === 'caverns' ? 0x39464f : 0x162831;
    for (let c = 0; c < 3; c++) rgba[i * 4 + c] = Math.min(255, ((color >> (16 - 8 * c)) & 255) * (ids[i] ? shade : 1));
    rgba[i * 4 + 3] = 255;
  }
  return { status: 'ready', rgba, heights: top, ids, palette, fallbackColumns, emptyLabel: options.mode === 'caverns' ? 'No exposed floor with 3 blocks of air below the roof' : 'No non-air blocks in this height range' };
}

/** Session-only LRU of projected pixels, never raw chunks. One request is at most 16 chunks. */
export function createTerrainReader(world, { cacheLimit = TERRAIN_CACHE_LIMIT } = {}) {
  requireThat(Number.isInteger(cacheLimit) && cacheLimit >= 1 && cacheLimit <= TERRAIN_CACHE_LIMIT, 'TERRAIN_CACHE', 'Invalid terrain cache limit.');
  const root = canonicalWorld(world.root), cache = new Map();
  const stamp = relative => {
    try { const s = fs.statSync(safePath(root, relative)); return `${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.ino}`; }
    catch (error) { if (error.code === 'ENOENT') return 'absent'; throw error; }
  };
  const metadataStable = () => requireThat(createHash('sha256').update(readBounded(root, 'level.dat', 16 * 1024 * 1024)).digest('hex') === world.fingerprint, 'WORLD_CHANGED', 'World metadata changed. Refresh the world map.');
  function batch(request) {
    requireThat(request && Array.isArray(request.chunks) && request.chunks.length > 0 && request.chunks.length <= TERRAIN_BATCH_LIMIT, 'TERRAIN_LIMIT', `Request 1–${TERRAIN_BATCH_LIMIT} chunks at a time.`);
    requireThat(request.chunks.every(c => c && Number.isInteger(c.x) && Number.isInteger(c.z) && Math.abs(c.x) <= 1875000 && Math.abs(c.z) <= 1875000), 'TERRAIN_COORDINATES', 'Terrain coordinates must be chunks inside the vanilla world border.');
    const dimension = world.dimensions.find(d => d.key === request.dimension);
    requireThat(dimension, 'TERRAIN_DIMENSION', 'Choose an inspected dimension.');
    const options = terrainOptions(world.metadata, dimension, request);
    metadataStable();
    const results = [];
    for (const { x, z } of request.chunks) {
      const id = `${dimension.key}:${options.mode}:${options.maxY}:${x},${z}`;
      const directory = path.join(dimension.path === '.' ? '' : dimension.path, 'region');
      const region = path.join(directory, `r.${Math.floor(x / 32)}.${Math.floor(z / 32)}.mca`), external = path.join(directory, `c.${x}.${z}.mcc`);
      let value, storageStamp;
      try {
        storageStamp = stamp(region) + '|' + stamp(external);
        const old = cache.get(id);
        if (old?.storageStamp === storageStamp) { cache.delete(id); cache.set(id, old); results.push(old.value); continue; }
        // Per-chunk reader releases expanded NBT immediately after projection. Its 32 MiB
        // record and 128 MiB expansion guards remain intact; no raw data enters the LRU.
        const reader = createChunkReader(root, dimension), chunk = reader.read(x, z);
        for (const region of reader.regions.values()) requireThat(!region?.issues.length, 'CHUNK_ALLOCATION', 'Region has structural errors; absence cannot be established.');
        value = chunk ? projectTerrain(chunk.nbt, options, dimension.id) : { status: 'absent', message: 'No saved chunk record.' };
        reader.verifyStable();
        requireThat(storageStamp === stamp(region) + '|' + stamp(external), 'CHUNK_CHANGED', 'Terrain changed while loading. Refresh the map.');
      } catch (error) { value = { status: error.code === 'TERRAIN_UNSUPPORTED' ? 'unsupported' : 'unreadable', code: error.code ?? 'IO_ERROR', message: error.message }; }
      value = { x, z, ...value };
      // Errors can be retried after refresh, but do not create a redraw/retry storm.
      cache.delete(id); cache.set(id, { storageStamp, value });
      while (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
      results.push(value);
    }
    metadataStable();
    return { tiles: results, cacheEntries: cache.size };
  }
  return { batch, get cacheSize() { return cache.size; } };
}
