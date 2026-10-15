import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { inspectRegion } from './anvil.js';
import { safePath, readBounded } from './paths.js';
import { parseNBT } from './nbt.js';
import { requireThat, WorldError } from './errors.js';

const MAX_COMPRESSED = 16 * 1024 * 1024;
const MAX_EXPANDED = 32 * 1024 * 1024;
export const isAir = state => ['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'].includes(state?.Name);
export const isFluid = state => ['minecraft:water', 'minecraft:lava'].includes(state?.Name) || state?.Properties?.waterlogged === 'true';
export function stateKey(state) { return state.Name + JSON.stringify(Object.entries(state.Properties ?? {}).sort(([a], [b]) => a.localeCompare(b))); }

// Normalize disk encodings at the read boundary. The viewer/archive comparison API
// continues to use Name/Properties; this does not enable a 26.3 write adapter.
function readBlockState(entry) {
  // Binary NBT represents heterogeneous lists as compounds. Only compact
  // string states may use the exact single-empty-key wrapper here; do not
  // unwrap arbitrary compounds globally or guess at future state schemas.
  if (entry && typeof entry === 'object' && Object.hasOwn(entry, '')) {
    requireThat(!Array.isArray(entry) && !Buffer.isBuffer(entry) && Object.keys(entry).length === 1 && typeof entry[''] === 'string', 'BLOCK_STATE', 'Invalid compact block-state wrapper.');
    entry = entry[''];
  }
  let name, properties;
  if (typeof entry === 'string') name = entry;
  else {
    requireThat(entry && typeof entry === 'object' && !Array.isArray(entry) && !Buffer.isBuffer(entry), 'BLOCK_STATE', 'Invalid block-state entry.');
    const legacy = Object.hasOwn(entry, 'Name'), modern = Object.hasOwn(entry, 'id');
    requireThat(legacy !== modern, 'BLOCK_STATE', 'Block state must have exactly one name encoding.');
    requireThat(!(legacy ? Object.hasOwn(entry, 'properties') : Object.hasOwn(entry, 'Properties')), 'BLOCK_STATE', 'Mixed block-state property encodings.');
    name = legacy ? entry.Name : entry.id;
    properties = legacy ? entry.Properties : entry.properties;
  }
  requireThat(typeof name === 'string' && /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(name), 'BLOCK_STATE', 'Invalid block name.');
  requireThat(properties === undefined || (properties && typeof properties === 'object' && !Array.isArray(properties) && !Buffer.isBuffer(properties) && Object.values(properties).every(v => typeof v === 'string')), 'BLOCK_STATE', 'Invalid block-state properties.');
  return { Name: name, ...(properties ? { Properties: { ...properties } } : {}) };
}

/** Modern disk palettes use non-spanning, padded 64-bit words; never network IDs. */
export function decodeSection(section) {
  requireThat(Number.isInteger(section.Y), 'SECTION_Y', 'Section Y is missing or invalid.');
  const states = section.block_states;
  requireThat(states && Array.isArray(states.palette) && states.palette.length > 0 && states.palette.length <= 4096, 'BLOCK_PALETTE', 'Missing or unsupported block palette.');
  const palette = states.palette.map(readBlockState);
  const indices = new Uint16Array(4096);
  if (palette.length === 1) {
    requireThat(states.data === undefined || (Array.isArray(states.data) && states.data.length === 0), 'BLOCK_DATA', 'Unexpected data for a single-state palette.');
    return { y: section.Y, palette, indices };
  }
  const bits = Math.max(4, Math.ceil(Math.log2(palette.length))), perWord = Math.floor(64 / bits), expected = Math.ceil(4096 / perWord);
  requireThat(Array.isArray(states.data) && states.data.length === expected, 'BLOCK_DATA', `Block-state word count mismatch: expected ${expected}.`);
  const low = new Uint32Array(expected), high = new Uint32Array(expected);
  for (let word = 0; word < expected; word++) {
    const value = states.data[word];
    requireThat(typeof value === 'string' && /^-?\d+$/.test(value), 'BLOCK_DATA', 'Block-state data must be signed NBT longs.');
    const n = BigInt(value); requireThat(n >= -(1n << 63n) && n < (1n << 63n), 'BLOCK_DATA', 'NBT long is out of range.');
    const unsigned = BigInt.asUintN(64, n);
    low[word] = Number(unsigned & 0xffffffffn); high[word] = Number(unsigned >> 32n);
  }
  // Validate every signed word above, then extract at most 12-bit palette IDs
  // using exact uint32 halves. Values that straddle bit 32 combine both halves;
  // each disk word remains padded, so indices never span a 64-bit boundary.
  const mask = (1 << bits) - 1;
  let at = 0;
  for (let word = 0; word < expected; word++) {
    for (let slot = 0; slot < perWord && at < 4096; slot++, at++) {
      const shift = slot * bits;
      const value = shift >= 32 ? high[word] >>> (shift - 32) :
        shift + bits <= 32 ? low[word] >>> shift : (low[word] >>> shift) | (high[word] << (32 - shift));
      const index = value & mask;
      requireThat(index < palette.length, 'BLOCK_INDEX', 'Block palette index is out of range.'); indices[at] = index;
    }
  }
  return { y: section.Y, palette, indices };
}

/** Read-only, bounded, per-operation cache. Missing chunks stay missing, not air. */
export function createChunkReader(root, dimension, { regionCache } = {}) {
  const regions = new Map(), chunks = new Map(), snapshots = new Map(), observations = new Map();
  let decodedBytes = 0;
  function observe(relative) {
    try { const s = fs.statSync(safePath(root, relative)); return `${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.ino}`; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  function read(x, z, store = 'region') {
    const id = `${store}:${x},${z}`; if (chunks.has(id)) return chunks.get(id);
    const relative = path.join(dimension.path === '.' ? '' : dimension.path, store, `r.${Math.floor(x / 32)}.${Math.floor(z / 32)}.mca`);
    if (!regions.has(relative)) {
      const storageStamp=observe(relative),cacheKey=path.join(root,relative);
      observations.set(relative, storageStamp);
      try {
        const old=regionCache?.get(cacheKey);
        const region=old?.storageStamp===storageStamp ? old.region : inspectRegion(root,relative);
        regions.set(relative,region);
        // Terrain alone opts into this header cache. Raw NBT/payloads never enter it.
        // Errors are re-inspected, including repaired/missing external payloads.
        if(regionCache&&!region.issues.length){regionCache.delete(cacheKey);regionCache.set(cacheKey,{storageStamp,region});while(regionCache.size>64)regionCache.delete(regionCache.keys().next().value);}
      }
      catch (error) { if (error.code === 'ENOENT') regions.set(relative, null); else throw error; }
    }
    const region = regions.get(relative), allocation = region?.chunks.find(c => c.x === x && c.z === z);
    if (!allocation) { chunks.set(id, null); return null; }
    requireThat(allocation.valid && region.issues.length === 0, 'CHUNK_ALLOCATION', `Chunk ${x}, ${z} has invalid region structure.`);
    const file = safePath(root, relative), fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let payload, marker;
    try {
      const before = fs.fstatSync(fd), location = Buffer.alloc(4), slot = ((x % 32 + 32) % 32) + ((z % 32 + 32) % 32) * 32;
      requireThat(fs.readSync(fd, location, 0, 4, slot * 4) === 4, 'CHUNK_CHANGED', 'Chunk location changed while reading.');
      const loc = location.readUInt32BE(0), offset = (loc >>> 8) * 4096, count = loc & 255, envelope = Buffer.alloc(5);
      requireThat(offset >= 8192 && count > 0 && offset + count * 4096 <= before.size, 'CHUNK_CHANGED', 'Chunk allocation changed while reading.');
      requireThat(fs.readSync(fd, envelope, 0, 5, offset) === 5, 'CHUNK_CHANGED', 'Chunk envelope is truncated.');
      const length = envelope.readUInt32BE(0); marker = envelope[4];
      requireThat(length >= 1 && length + 4 <= count * 4096, 'CHUNK_LENGTH', 'Invalid chunk payload length.');
      if (marker & 128) {
        requireThat(length === 1, 'CHUNK_LENGTH', 'Invalid external payload stub.');
        payload = readBounded(root, path.join(path.dirname(relative), `c.${x}.${z}.mcc`), MAX_COMPRESSED);
        observations.set(path.join(path.dirname(relative), `c.${x}.${z}.mcc`), observe(path.join(path.dirname(relative), `c.${x}.${z}.mcc`)));
      } else {
        requireThat(length > 1 && length - 1 <= MAX_COMPRESSED, 'CHUNK_LENGTH', 'Chunk payload is empty or too large.');
        payload = Buffer.alloc(length - 1);
        requireThat(fs.readSync(fd, payload, 0, payload.length, offset + 5) === payload.length, 'CHUNK_CHANGED', 'Chunk payload changed while reading.');
      }
      const after = fs.fstatSync(fd);
      requireThat(before.size === after.size && before.mtimeMs === after.mtimeMs, 'CHUNK_CHANGED', 'Region changed while reading. Close Minecraft and rescan.');
    } finally { fs.closeSync(fd); }
    let raw;
    try {
      switch (marker & 127) {
        case 1: raw = gunzipSync(payload, { maxOutputLength: MAX_EXPANDED }); break;
        case 2: raw = inflateSync(payload, { maxOutputLength: MAX_EXPANDED }); break;
        case 3: raw = payload; break;
        default: throw new WorldError('CHUNK_COMPRESSION', 'Block previews currently support gzip, zlib and uncompressed chunks. Other compression is blocked.');
      }
    } catch (error) { if (error instanceof WorldError) throw error; throw new WorldError('CHUNK_DECOMPRESSION', 'Invalid compressed chunk or decompression limit exceeded.'); }
    requireThat(raw.length <= MAX_EXPANDED, 'CHUNK_SIZE', 'Chunk NBT exceeds 32 MiB.');
    decodedBytes += raw.length;
    requireThat(decodedBytes <= 128 * 1024 * 1024, 'CHUNK_BUDGET', 'Selection expands beyond the 128 MiB chunk decoding budget.');
    const nbt = parseNBT(raw);
    if (store === 'region') {
      requireThat(nbt.xPos === x && nbt.zPos === z, 'CHUNK_POSITION', 'Chunk NBT coordinates disagree with its region location.');
      requireThat(nbt.Status === 'minecraft:full' || nbt.Status === 'full', 'CHUNK_STATUS', 'Chunk generation is incomplete. Block preview will not invent its missing terrain.');
      requireThat(Number.isInteger(nbt.DataVersion) && Array.isArray(nbt.sections), 'CHUNK_SCHEMA', 'Unsupported chunk schema or missing DataVersion.');
    }
    snapshots.set(id, { store, x, z, sha256: createHash('sha256').update(Buffer.from([marker])).update(payload).digest('hex'), dataVersion: nbt.DataVersion ?? null });
    const result = { nbt, raw, decoded: new Map() }; chunks.set(id, result); return result;
  }
  function block(x, y, z) {
    const chunk = read(Math.floor(x / 16), Math.floor(z / 16)); if (!chunk) return null;
    const sectionY = Math.floor(y / 16);
    if (!chunk.decoded.has(sectionY)) {
      const matches = chunk.nbt.sections.filter(s => s.Y === sectionY);
      requireThat(matches.length <= 1, 'SECTION_DUPLICATE', 'Duplicate section Y.');
      chunk.decoded.set(sectionY, matches.length && matches[0].block_states ? decodeSection(matches[0]) : null);
    }
    const section = chunk.decoded.get(sectionY); if (!section) return null;
    const i = ((y % 16 + 16) % 16) * 256 + ((z % 16 + 16) % 16) * 16 + ((x % 16 + 16) % 16);
    return section.palette[section.indices[i]];
  }
  function verifyStable() { for (const [relative, stamp] of observations) requireThat(observe(relative) === stamp, 'CHUNK_CHANGED', 'Chunk storage changed during selection. Close Minecraft and retry.'); }
  return { read, block, snapshots, regions, verifyStable };
}
