import { createHash } from 'node:crypto';
import { decodeDat, NBT_LIMITS } from './nbt.js';
import { readBounded, canonicalWorld } from './paths.js';
import { createChunkReader, stateKey, isAir, isFluid } from './chunks.js';
import { requireThat } from './errors.js';

export const VOLUME_LIMIT = 1048576;
export function validateBounds(input) {
  requireThat(input && typeof input === 'object', 'VOLUME_BOUNDS', 'Enter a block selection.');
  const bounds = {};
  for (const k of ['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ']) { requireThat(Number.isSafeInteger(input[k]) && Math.abs(input[k]) <= 30000000, 'VOLUME_BOUNDS', 'Selection coordinates must be whole numbers within ±30,000,000.'); bounds[k] = input[k]; }
  const size = { x: bounds.maxX - bounds.minX + 1, y: bounds.maxY - bounds.minY + 1, z: bounds.maxZ - bounds.minZ + 1 };
  requireThat(size.x > 0 && size.y > 0 && size.z > 0, 'VOLUME_BOUNDS', 'Each maximum coordinate must be at least its minimum.');
  requireThat(size.x <= 128 && size.z <= 128 && size.y <= 384 && size.x * size.y * size.z <= VOLUME_LIMIT, 'VOLUME_LIMIT', 'Preview limit: 128 × 384 × 128 extent and 1,048,576 total blocks. Reduce the selection.');
  return { bounds, size, count: size.x * size.y * size.z };
}
export function indexOf(size, x, y, z) { return y * size.x * size.z + z * size.x + x; }
export function volumeBlock(volume, x, y, z) {
  const b = volume.bounds;
  if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY || z < b.minZ || z > b.maxZ) return null;
  const id = volume.voxels[indexOf(volume.size, x - b.minX, y - b.minY, z - b.minZ)];
  return id === 0 ? null : volume.palette[id];
}
export function captureVolume(world, dimensionKey, input, progress = () => {}) {
  const root = canonicalWorld(world.root), dimension = world.dimensions.find(d => d.key === dimensionKey);
  requireThat(dimension, 'VOLUME_DIMENSION', 'Choose a dimension from the inspected source world.');
  const before = readBounded(root, 'level.dat', NBT_LIMITS.compressed), fingerprint = createHash('sha256').update(before).digest('hex');
  requireThat(fingerprint === world.fingerprint, 'WORLD_CHANGED', 'World metadata changed. Rescan before selecting a build.');
  const version = decodeDat(before).Data?.Version?.Name;
  requireThat(typeof version === 'string' && /^26\.[23](?:\.\d+)?$/.test(version), 'VOLUME_VERSION', 'Block previews currently target stable Java 26.2 and 26.3 schemas. Other versions remain header-only.');
  const { bounds, size, count } = validateBounds(input), voxels = new Uint32Array(count), palette = [null], paletteIds = new Map();
  const reader = createChunkReader(root, dimension), issues = [], missingChunks = [], attachments = { blockEntities: [], blockTicks: [], fluidTicks: [], entityCount: null, biomesTransferred: false };
  let unknown = 0, air = 0, fluids = 0, nonAir = 0;
  const touched = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
  const inside = p => p && Number.isInteger(p.x) && Number.isInteger(p.y) && Number.isInteger(p.z) && p.x >= bounds.minX && p.x <= bounds.maxX && p.y >= bounds.minY && p.y <= bounds.maxY && p.z >= bounds.minZ && p.z <= bounds.maxZ;
  for (let cz = Math.floor(bounds.minZ / 16); cz <= Math.floor(bounds.maxZ / 16); cz++) for (let cx = Math.floor(bounds.minX / 16); cx <= Math.floor(bounds.maxX / 16); cx++) {
    progress({ phase: 'Reading full-height block selection', file: `chunk ${cx}, ${cz}` });
    let chunk;
    try { chunk = reader.read(cx, cz); }
    catch (error) { issues.push(`Chunk ${cx}, ${cz}: ${error.message}`); }
    if (!chunk) { missingChunks.push({ x: cx, z: cz }); continue; }
    for (const [field, key] of [['block_entities', 'blockEntities'], ['block_ticks', 'blockTicks'], ['fluid_ticks', 'fluidTicks']]) {
      if (Array.isArray(chunk.nbt[field])) attachments[key].push(...chunk.nbt[field].filter(inside));
      else issues.push(`Chunk ${cx}, ${cz}: ${field} is unavailable; related metadata is not certified.`);
    }
    try {
      for (let y = bounds.minY; y <= bounds.maxY; y++) for (let z = Math.max(cz * 16, bounds.minZ); z <= Math.min(cz * 16 + 15, bounds.maxZ); z++) for (let x = Math.max(cx * 16, bounds.minX); x <= Math.min(cx * 16 + 15, bounds.maxX); x++) {
        const state = reader.block(x, y, z); if (!state) continue;
        const key = stateKey(state); let id = paletteIds.get(key);
        if (id === undefined) { id = palette.length; palette.push(state); paletteIds.set(key, id); }
        voxels[indexOf(size, x - bounds.minX, y - bounds.minY, z - bounds.minZ)] = id;
      }
    } catch (error) {
      issues.push(`Chunk ${cx}, ${cz}: ${error.message}`);
      // A partially decoded chunk must not appear complete.
      for (let y = 0; y < size.y; y++) for (let z = Math.max(cz * 16, bounds.minZ); z <= Math.min(cz * 16 + 15, bounds.maxZ); z++) for (let x = Math.max(cx * 16, bounds.minX); x <= Math.min(cx * 16 + 15, bounds.maxX); x++) voxels[indexOf(size, x - bounds.minX, y, z - bounds.minZ)] = 0;
    }
  }
  for (let y = 0; y < size.y; y++) for (let z = 0; z < size.z; z++) for (let x = 0; x < size.x; x++) {
    const state = palette[voxels[indexOf(size, x, y, z)]];
    if (!state) { unknown++; continue; }
    if (isAir(state)) air++;
    else {
      nonAir++; if (isFluid(state)) fluids++;
      if (x === 0) touched.minX++; if (x === size.x - 1) touched.maxX++; if (y === 0) touched.minY++; if (y === size.y - 1) touched.maxY++; if (z === 0) touched.minZ++; if (z === size.z - 1) touched.maxZ++;
    }
  }
  const after = readBounded(root, 'level.dat', NBT_LIMITS.compressed);
  reader.verifyStable();
  requireThat(createHash('sha256').update(after).digest('hex') === fingerprint, 'WORLD_CHANGED', 'World metadata changed during capture. Close Minecraft and rescan.');
  const digest = createHash('sha256').update(JSON.stringify({ bounds, palette })).update(Buffer.from(voxels.buffer)).digest('hex');
  return { schemaVersion: 1, root, dimension: dimension.key, version, dataVersion: world.metadata.dataVersion, bounds, size, palette, voxels, digest, capturedAt: new Date().toISOString(), stats: { total: count, nonAir, air, fluids, unknown, paletteStates: palette.length - 1 }, boundaryNonAir: touched, complete: unknown === 0 && issues.length === 0, issues, missingChunks, attachments, snapshots: [...reader.snapshots.values()] };
}
