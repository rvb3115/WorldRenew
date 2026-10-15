import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { requireThat, WorldError } from './errors.js';
import { safePath } from './paths.js';
import { readBuildFile, externalParent, validEntity } from './build-archive.js';
import { parseNBT } from './nbt.js';
import { decodeSection, isAir, isFluid } from './chunks.js';
import { validateConfigurationProvenance } from './world-configuration.js';

export const TEMPLATE_MAGIC = Buffer.from('WRBUILD2\n');
const LEGACY_MAGIC = Buffer.from('WRBUILD1\n');
export const TEMPLATE_LIMITS = Object.freeze({ metadata: 1024 * 1024, record: 32 * 1024 * 1024, sections: 4096, frame: 100 * 1024 * 1024, compressedFrame: 101 * 1024 * 1024 });
const STORES = ['region', 'entities', 'poi'];
const hash = b => createHash('sha256').update(b).digest();
const fail = (ok, message) => requireThat(ok, 'TEMPLATE_FORMAT', message);
const int = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;
const object = v => v && typeof v === 'object' && !Array.isArray(v);
export function checkTemplateCancellation(options = {}) {
  if (options.signal?.aborted || options.shouldCancel?.()) throw new WorldError('TEMPLATE_CANCELLED', 'Template operation cancelled.');
}
function progress(options, value) { checkTemplateCancellation(options); options.onProgress?.(value); checkTemplateCancellation(options); }
function jsonBytes(value) {
  const bytes = Buffer.from(JSON.stringify(value));
  requireThat(bytes.length <= TEMPLATE_LIMITS.metadata, 'TEMPLATE_LIMIT', 'Template metadata exceeds 1 MiB.');
  return bytes;
}
function jsonParse(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new WorldError('TEMPLATE_FORMAT', 'Invalid template metadata JSON.'); }
}
function validateBounds(bounds) {
  fail(object(bounds), 'Missing template bounds.');
  for (const axis of ['X', 'Y', 'Z']) fail(int(bounds[`min${axis}`], -30000000, 30000000) && int(bounds[`max${axis}`], bounds[`min${axis}`], 30000000), 'Invalid template bounds.');
}
function validateHeader(header) {
  fail(header?.format === 'WorldRenew.build' && header.schema === 2, 'Unsupported streaming template format.');
  const s = header.source;
  fail(object(s) && typeof s.name === 'string' && s.name.length <= 1024 && typeof s.version === 'string' && /^26\.[23](?:\.\d+)?$/.test(s.version) && int(s.dataVersion, 0, 2147483647) && typeof s.dimensionId === 'string' && /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(s.dimensionId) && typeof s.dimensionKey === 'string' && s.dimensionKey.length <= 4096, 'Invalid template provenance.');
  validateBounds(s.bounds);
  if (s.configuration !== undefined) validateConfigurationProvenance(s.configuration);
  jsonBytes(header);
  return header;
}
function popcount(mask) { let count = 0; for (const v of mask) { let b = v; while (b) { b &= b - 1; count++; } } return count; }
function inside(x, y, z, b) { return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && z >= b.minZ && z <= b.maxZ; }
function validateChunk(chunk, header, options) {
  checkTemplateCancellation(options);
  fail(object(chunk) && int(chunk.x, -1875000, 1875000) && int(chunk.z, -1875000, 1875000), 'Invalid template chunk coordinates.');
  fail(Array.isArray(chunk.sections) && chunk.sections.length > 0 && chunk.sections.length <= TEMPLATE_LIMITS.sections, 'Invalid or excessive section masks in chunk.');
  fail(object(chunk.records) && STORES.every(s => Object.hasOwn(chunk.records, s)), 'Missing supporting chunk records.');
  const decoded = {};
  let rawBytes = 0;
  for (const store of STORES) {
    const raw = chunk.records[store];
    if (raw === null) { fail(store !== 'region', 'Unknown terrain cannot be saved as air.'); decoded[store] = null; continue; }
    fail(Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= TEMPLATE_LIMITS.record, 'Invalid or oversized supporting record.');
    rawBytes += raw.length;
    const nbt = parseNBT(raw);
    fail((store === 'poi' && nbt.DataVersion === undefined) || nbt.DataVersion === header.source.dataVersion, 'Inconsistent chunk DataVersion.');
    if (store === 'region') {
      fail(nbt.xPos === chunk.x && nbt.zPos === chunk.z && ['full', 'minecraft:full'].includes(nbt.Status) && Array.isArray(nbt.sections), 'Invalid terrain chunk.');
      fail(nbt.sections.every(s => Number.isSafeInteger(s.Y)) && new Set(nbt.sections.map(s => s.Y)).size === nbt.sections.length, 'Duplicate or invalid terrain section.');
      for (const key of ['block_entities', 'block_ticks', 'fluid_ticks']) fail(Array.isArray(nbt[key]) && nbt[key].every(p => p && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]))), `Invalid ${key} records.`);
    }
    if (store === 'entities') fail(Array.isArray(nbt.Position) && nbt.Position.length === 2 && nbt.Position[0] === chunk.x && nbt.Position[1] === chunk.z && Array.isArray(nbt.Entities) && nbt.Entities.every(validEntity), 'Invalid entity records.');
    decoded[store] = nbt;
  }
  const byY = new Map(decoded.region.sections.map(s => [s.Y, s]));
  let lastY = -Infinity, selectedBlocks = 0, air = 0, nonAir = 0, fluids = 0;
  for (const section of chunk.sections) {
    checkTemplateCancellation(options);
    fail(int(section.y, -1875000, 1875000) && section.y > lastY, 'Section masks must be unique and ordered by Y.'); lastY = section.y;
    fail(Buffer.isBuffer(section.mask) && section.mask.length === 512 && popcount(section.mask) > 0, 'Invalid or empty selection mask.');
    const rawSection = byY.get(section.y);
    requireThat(rawSection?.block_states, 'TEMPLATE_UNKNOWN', 'Selected terrain has no known block section; it cannot become air.');
    const states = decodeSection(rawSection);
    for (let i = 0; i < 4096; i++) if (section.mask[i >> 3] & (1 << (i & 7))) {
      fail(inside(chunk.x * 16 + i % 16, section.y * 16 + (i >> 8), chunk.z * 16 + ((i >> 4) & 15), header.source.bounds), 'Selected cell lies outside template bounds.');
      selectedBlocks++;
      const state = states.palette[states.indices[i]];
      if (isAir(state)) air++; else { nonAir++; if (isFluid(state)) fluids++; }
    }
  }
  return { selectedBlocks, air, nonAir, fluids, rawBytes };
}
function encodeChunk(chunk) {
  const blobs = [], sections = chunk.sections.map(section => {
    const { mask, ...extra } = section;
    const full = mask.every(b => b === 255);
    if (!full) blobs.push(mask);
    return { ...extra, mask: full ? 'full' : 'bits' };
  });
  const records = { ...chunk.records };
  for (const store of STORES) {
    const raw = chunk.records[store]; if (raw !== null) blobs.push(raw);
    records[store] = raw === null ? null : raw.length;
  }
  const metadata = jsonBytes({ ...chunk, sections, records });
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(metadata.length);
  const total = 4 + metadata.length + blobs.reduce((n, b) => n + b.length, 0);
  requireThat(total <= TEMPLATE_LIMITS.frame, 'TEMPLATE_LIMIT', 'Template chunk exceeds the expanded frame limit.');
  return Buffer.concat([prefix, metadata, ...blobs], total);
}
function decodeChunk(raw) {
  fail(raw.length >= 4, 'Truncated chunk manifest.');
  const length = raw.readUInt32BE(0);
  fail(length > 0 && length <= TEMPLATE_LIMITS.metadata && 4 + length <= raw.length, 'Invalid chunk manifest size.');
  const chunk = jsonParse(raw.subarray(4, 4 + length));
  fail(object(chunk) && Array.isArray(chunk.sections) && chunk.sections.length > 0 && chunk.sections.length <= TEMPLATE_LIMITS.sections && object(chunk.records), 'Invalid chunk manifest.');
  let offset = 4 + length;
  const take = length => { fail(offset + length <= raw.length, 'Truncated chunk payload.'); const b = raw.subarray(offset, offset + length); offset += length; return b; };
  chunk.sections = chunk.sections.map(s => {
    fail(object(s) && ['full', 'bits'].includes(s.mask), 'Invalid mask encoding.');
    return { ...s, mask: s.mask === 'full' ? Buffer.alloc(512, 255) : take(512) };
  });
  for (const store of STORES) {
    const length = chunk.records[store];
    fail(length === null || int(length, 1, TEMPLATE_LIMITS.record), 'Invalid supporting record length.');
    chunk.records[store] = length === null ? null : take(length);
  }
  fail(offset === raw.length, 'Trailing chunk payload.');
  return chunk;
}
function counter() { return { chunks: 0, selectedBlocks: 0n, air: 0n, nonAir: 0n, fluids: 0n, rawBytes: 0n }; }
function add(stats, chunkStats, options) {
  stats.chunks++;
  for (const key of ['selectedBlocks', 'air', 'nonAir', 'fluids', 'rawBytes']) stats[key] += BigInt(chunkStats[key]);
  if (options.maxChunks !== undefined) requireThat(stats.chunks <= options.maxChunks, 'TEMPLATE_BUDGET', 'Template exceeds the requested chunk budget.');
  if (options.maxSelectedBlocks !== undefined) requireThat(stats.selectedBlocks <= BigInt(options.maxSelectedBlocks), 'TEMPLATE_BUDGET', 'Template exceeds the requested selected-block budget.');
}
function summary(stats) { return Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])); }
function ordered(last, chunk) { fail(!last || chunk.z > last.z || (chunk.z === last.z && chunk.x > last.x), 'Chunk frames must be unique and ordered by Z then X.'); return { x: chunk.x, z: chunk.z }; }
function writeAll(fd, bytes) { let at = 0; while (at < bytes.length) { const n = fs.writeSync(fd, bytes, at, bytes.length - at); requireThat(n > 0, 'TEMPLATE_IO', 'Short template write.'); at += n; } }

/** Atomic, exclusive publication; memory is bounded by one chunk frame, not build size. */
export function writeTemplateStream(file, header, chunks, options = {}) {
  checkTemplateCancellation(options); validateHeader(header);
  const parent = externalParent(path.dirname(path.resolve(file)), options.worlds ?? []), target = path.join(parent, path.basename(file));
  requireThat(!fs.existsSync(target), 'TEMPLATE_EXISTS', 'Template files are never overwritten.');
  const temporary = path.join(parent, `.worldrenew-${randomUUID()}.partial`), fd = fs.openSync(temporary, 'wx', 0o600);
  const prefixHash = createHash('sha256'), fullHash = createHash('sha256'), stats = counter();
  let last, expanded = 0n, bytesWritten = 0;
  const write = (bytes, prefix = true) => { writeAll(fd, bytes); fullHash.update(bytes); if (prefix) prefixHash.update(bytes); bytesWritten += bytes.length; };
  try {
    const metadata = jsonBytes(header), size = Buffer.alloc(4); size.writeUInt32BE(metadata.length);
    write(TEMPLATE_MAGIC); write(size); write(metadata);
    for (const chunk of chunks) {
      checkTemplateCancellation(options); last = ordered(last, chunk);
      const chunkStats = validateChunk(chunk, header, options), raw = encodeChunk(chunk);
      expanded += BigInt(raw.length); if (options.maxExpandedBytes !== undefined) requireThat(expanded <= BigInt(options.maxExpandedBytes), 'TEMPLATE_BUDGET', 'Template exceeds the requested expanded-byte budget.');
      const packed = deflateSync(raw);
      requireThat(packed.length <= TEMPLATE_LIMITS.compressedFrame, 'TEMPLATE_LIMIT', 'Compressed chunk exceeds frame limit.');
      const envelope = Buffer.alloc(41); envelope[0] = 1; envelope.writeUInt32BE(packed.length, 1); envelope.writeUInt32BE(raw.length, 5); hash(raw).copy(envelope, 9);
      add(stats, chunkStats, options); write(envelope); write(packed);
      progress(options, { phase: 'Writing template', ...summary(stats), bytes: bytesWritten });
    }
    requireThat(stats.chunks > 0, 'TEMPLATE_EMPTY', 'Select at least one known block.');
    const footer = jsonBytes({ ...summary(stats), expandedBytes: expanded.toString(), contentDigest: prefixHash.digest('hex') });
    const envelope = Buffer.alloc(5); envelope.writeUInt32BE(footer.length, 1); write(envelope, false); write(footer, false);
    fs.fsyncSync(fd);
    const savedIdentity = fs.fstatSync(fd, { bigint: true });
    const digest = fullHash.digest('hex');
    const checked = validateTemplateStream(temporary, options);
    requireThat(checked.digest === digest, 'TEMPLATE_VERIFY', 'Saved template verification failed.');
    options.beforePublish?.();
    checkTemplateCancellation(options);
    let savedPath; try { savedPath = fs.lstatSync(temporary, { bigint: true }); } catch {}
    const savedDescriptor = fs.fstatSync(fd, { bigint: true });
    const unchanged = stat => stat?.isFile() && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(k => stat[k] === savedIdentity[k]);
    requireThat(unchanged(savedDescriptor) && unchanged(savedPath), 'TEMPLATE_CHANGED', 'Verified template changed before publication.');
    fs.linkSync(temporary, target);
    return { file: target, header: checked.header, summary: checked.summary, digest };
  } finally { fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}

/** Exhaust the iterator before trusting the final integrity digest. Early return closes the descriptor. */
export function* iterateTemplate(file, options = {}) {
  checkTemplateCancellation(options);
  const absolute = path.resolve(file), safe = safePath(path.dirname(absolute), path.basename(absolute));
  const fd = fs.openSync(safe, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const identity = fs.fstatSync(fd, { bigint: true });
  const before = fs.fstatSync(fd), fullHash = createHash('sha256'), prefixHash = createHash('sha256');
  let position = 0;
  const read = (length, prefix = true) => {
    checkTemplateCancellation(options);
    fail(int(length, 0, TEMPLATE_LIMITS.compressedFrame) && position + length <= before.size, 'Truncated template file.');
    const bytes = Buffer.alloc(length); let at = 0;
    while (at < length) { const n = fs.readSync(fd, bytes, at, length - at, position + at); fail(n > 0, 'Truncated template file.'); at += n; }
    position += length; fullHash.update(bytes); if (prefix) prefixHash.update(bytes); return bytes;
  };
  const stable = () => {
    const after = fs.fstatSync(fd, { bigint: true });
    let current; try { current = fs.lstatSync(safe, { bigint: true }); } catch {}
    const matches = s => s?.isFile() && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(k => s[k] === identity[k]);
    requireThat(matches(after) && matches(current), 'TEMPLATE_CHANGED', 'Template changed while reading.');
  };
  try {
    fail(before.isFile() && Number.isSafeInteger(before.size), 'Template must be a regular file.');
    if (options.maxFileBytes !== undefined) requireThat(before.size <= options.maxFileBytes, 'TEMPLATE_BUDGET', 'Template exceeds requested file-byte budget.');
    const magic = read(TEMPLATE_MAGIC.length);
    if (magic.equals(LEGACY_MAGIC)) {
      const legacy = readBuildFile(safe); stable();
      const header = { ...legacy.archive, schema: 2 }; delete header.records;
      header.legacySchema = 1;
      yield { type: 'header', header };
      const b = header.source.bounds, stats = counter();
      for (let z = Math.floor(b.minZ / 16); z <= Math.floor(b.maxZ / 16); z++) for (let x = Math.floor(b.minX / 16); x <= Math.floor(b.maxX / 16); x++) {
        const sections = [];
        for (let y = Math.floor(b.minY / 16); y <= Math.floor(b.maxY / 16); y++) {
          const mask = Buffer.alloc(512);
          for (let i = 0; i < 4096; i++) if (inside(x * 16 + i % 16, y * 16 + (i >> 8), z * 16 + ((i >> 4) & 15), b)) mask[i >> 3] |= 1 << (i & 7);
          sections.push({ y, mask });
        }
        const recordMetadata = Object.fromEntries(STORES.map(store => {
          const r = legacy.archive.records.find(r => r.store === store && r.x === x && r.z === z);
          const { nbt, sha256, store: originalStore, x: originalX, z: originalZ, ...extra } = r;
          return [store, extra];
        }));
        const chunk = { x, z, sections, records: Object.fromEntries(STORES.map(s => [s, legacy.decoded.get(`${s}:${x},${z}`)?.raw ?? null])), recordMetadata };
        add(stats, validateChunk(chunk, header, options), options);
        progress(options, { phase: 'Reading legacy template', ...summary(stats) });
        yield { type: 'chunk', chunk };
      }
      stable(); yield { type: 'end', summary: summary(stats), digest: legacy.digest }; return;
    }
    fail(magic.equals(TEMPLATE_MAGIC), 'This is not a WorldRenew template file.');
    const headerLength = read(4).readUInt32BE(0);
    fail(headerLength > 0 && headerLength <= TEMPLATE_LIMITS.metadata, 'Invalid template header size.');
    const header = validateHeader(jsonParse(read(headerLength)));
    yield { type: 'header', header };
    const stats = counter(); let last, expanded = 0n;
    for (;;) {
      const kind = read(1, false)[0];
      if (kind === 0) {
        const length = read(4, false).readUInt32BE(0);
        fail(length > 0 && length <= TEMPLATE_LIMITS.metadata, 'Invalid template footer size.');
        const footer = jsonParse(read(length, false));
        fail(object(footer) && stats.chunks > 0 && position === before.size, 'Empty template or trailing file bytes.');
        for (const [key, value] of Object.entries(summary(stats))) fail(footer[key] === value, 'Template footer counts do not match.');
        requireThat(footer.contentDigest === prefixHash.digest('hex') && footer.expandedBytes === expanded.toString(), 'TEMPLATE_CHECKSUM', 'Template content checksum failed.');
        stable(); checkTemplateCancellation(options);
        yield { type: 'end', summary: summary(stats), digest: fullHash.digest('hex') }; return;
      }
      fail(kind === 1, 'Unsupported template frame type.'); prefixHash.update(Buffer.from([kind]));
      const envelope = read(40), packedLength = envelope.readUInt32BE(0), rawLength = envelope.readUInt32BE(4);
      fail(packedLength > 0 && packedLength <= TEMPLATE_LIMITS.compressedFrame && rawLength > 0 && rawLength <= TEMPLATE_LIMITS.frame, 'Invalid or oversized template frame.');
      expanded += BigInt(rawLength);
      if (options.maxExpandedBytes !== undefined) requireThat(expanded <= BigInt(options.maxExpandedBytes), 'TEMPLATE_BUDGET', 'Template exceeds requested expanded-byte budget.');
      let unpacked;
      const packed = read(packedLength);
      try { unpacked = inflateSync(packed, { maxOutputLength: rawLength, info: true }); }
      catch { throw new WorldError('TEMPLATE_DECOMPRESSION', 'Damaged template frame or decompression limit exceeded.'); }
      fail(unpacked.buffer.length === rawLength && unpacked.engine.bytesWritten === packedLength, 'Invalid frame length or trailing compressed bytes.');
      requireThat(hash(unpacked.buffer).equals(envelope.subarray(8)), 'TEMPLATE_CHECKSUM', 'Template frame checksum failed.');
      const chunk = decodeChunk(unpacked.buffer); last = ordered(last, chunk);
      add(stats, validateChunk(chunk, header, options), options);
      progress(options, { phase: 'Reading template', ...summary(stats), bytes: position });
      yield { type: 'chunk', chunk };
    }
  } finally { fs.closeSync(fd); }
}
export function validateTemplateStream(file, options = {}) {
  let header, result;
  for (const event of iterateTemplate(file, options)) { if (event.type === 'header') header = event.header; if (event.type === 'end') result = event; }
  return { header, summary: result.summary, digest: result.digest };
}

/** Selected air returns its exact state; excluded cells are never yielded. */
export function* selectedTemplateBlocks(chunk) {
  const nbt = parseNBT(chunk.records.region), sections = new Map(nbt.sections.map(s => [s.Y, s]));
  for (const section of chunk.sections) {
    const states = decodeSection(sections.get(section.y));
    for (let i = 0; i < 4096; i++) if (section.mask[i >> 3] & (1 << (i & 7))) yield { x: chunk.x * 16 + i % 16, y: section.y * 16 + (i >> 8), z: chunk.z * 16 + ((i >> 4) & 15), state: states.palette[states.indices[i]] };
  }
}
