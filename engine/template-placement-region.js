import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { inspectRegion } from './anvil.js';
import { externalParent } from './build-archive.js';
import { createChunkReader } from './chunks.js';
import { canonicalWorld, safePath } from './paths.js';
import { parseNBT } from './nbt.js';
import { requireThat } from './errors.js';
import { checkTemplateCancellation } from './template-stream.js';

const SECTOR = 4096, HEADER = 8192, MAX_REGION = 256 * 1024 * 1024, MAX_RAW = 32 * 1024 * 1024;
const COPY_BYTES = 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const stat = fd => fs.fstatSync(fd, { bigint: true });
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a, b) => sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.mode === b.mode && a.nlink === b.nlink;

function readExact(fd, bytes, position) {
  let done = 0;
  while (done < bytes.length) {
    const length = fs.readSync(fd, bytes, done, bytes.length - done, position + done);
    requireThat(length > 0, 'REGION_CHANGED', 'Region file became truncated while preparing placement.'); done += length;
  }
}

/**
 * Prepare one region OUTSIDE all worlds; the caller alone may install it in its
 * owned disposable copy after policy checks and complete-operation verification.
 * No world file is opened for writing. At most one decoded chunk is retained;
 * untouched allocations (including padding and external stubs) are copied in
 * 1 MiB batches. This storage primitive does not authorize any placement policy.
 */
export function prepareTemplateRegion(root, dimension, regionX, regionZ, outputFile, slots, transform, options = {}) {
  requireThat(Number.isSafeInteger(regionX * 32) && Number.isSafeInteger(regionX * 32 + 31) && Number.isSafeInteger(regionZ * 32) && Number.isSafeInteger(regionZ * 32 + 31) && Number.isInteger(regionX) && Number.isInteger(regionZ),
    'REGION_COORD', 'Invalid placement region coordinates.');
  requireThat(dimension && typeof dimension.path === 'string' && dimension.path.length > 0, 'REGION_PATH', 'Missing destination dimension path.');
  requireThat(slots instanceof Set && [...slots].every(slot => Number.isInteger(slot) && slot >= 0 && slot < 1024), 'REGION_SLOTS', 'Placement region slots must be integers from 0 through 1023.');
  requireThat(typeof transform === 'function' && (options.onProgress === undefined || typeof options.onProgress === 'function') && (options.shouldCancel === undefined || typeof options.shouldCancel === 'function'),
    'REGION_CALLBACK', 'Invalid placement transformation or progress callback.');
  requireThat(typeof outputFile === 'string' && outputFile.length > 0, 'REGION_PATH', 'Choose a new prepared-region filename.');
  const selected = new Set(slots), destinationDimension = { path: dimension.path }, world = canonicalWorld(root), relative = path.join(destinationDimension.path === '.' ? '' : destinationDimension.path, 'region', `r.${regionX}.${regionZ}.mca`);
  const original = safePath(world, relative), sourceFD = fs.openSync(original, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let outputFD, file, owned, outputStamp, outputParent, parentStamp;
  const sourceStamp = stat(sourceFD);
  const sourceStable = () => {
    const current = fs.lstatSync(safePath(world, relative), { bigint: true });
    requireThat(current.isFile() && sameFile(sourceStamp, stat(sourceFD)) && sameFile(sourceStamp, current), 'REGION_CHANGED', 'Original region changed during placement preparation. Close Minecraft and retry.');
  };
  const outputStable = () => {
    if (outputFD === undefined) return;
    const parent = fs.lstatSync(outputParent, { bigint: true }), current = fs.lstatSync(file, { bigint: true });
    requireThat(parent.isDirectory() && !parent.isSymbolicLink() && sameIdentity(parentStamp, parent) && fs.realpathSync(outputParent) === outputParent && current.isFile() && sameFile(outputStamp, current) && sameFile(outputStamp, stat(outputFD)),
      'REGION_OUTPUT_CHANGED', 'Prepared region or its output directory changed during placement.');
  };
  // Cancellation predicates and progress callbacks are user code. Check both
  // sides so they cannot modify either file and have that mutation accepted.
  const check = () => { sourceStable(); outputStable(); checkTemplateCancellation(options); sourceStable(); outputStable(); };
  const report = value => { check(); options.onProgress?.(value); check(); };
  const write = (bytes, position) => {
    let done = 0;
    while (done < bytes.length) {
      check();
      const length = fs.writeSync(outputFD, bytes, done, Math.min(COPY_BYTES, bytes.length - done), position + done);
      requireThat(length > 0, 'REGION_WRITE', 'Could not write the complete prepared region.'); done += length;
      outputStamp = stat(outputFD);
    }
  };
  try {
    requireThat(sourceStamp.isFile() && sourceStamp.size >= BigInt(HEADER) && sourceStamp.size <= BigInt(MAX_REGION), 'REGION_SIZE', 'Unsupported region size for copy placement (8 KiB through 256 MiB).');
    check();
    const inspected = inspectRegion(world, relative);
    requireThat(inspected.issues.length === 0 && inspected.invalid === 0 && !inspected.uninitialized, 'REGION_ALLOCATION', 'Original region failed structural checks.');
    check();
    const sourceHeader = Buffer.alloc(HEADER); readExact(sourceFD, sourceHeader, 0);
    const header = Buffer.from(sourceHeader), bySlot = new Map(inspected.chunks.map(chunk => [(chunk.x - regionX * 32) + (chunk.z - regionZ * 32) * 32, chunk]));
    for (const slot of selected) {
      requireThat(bySlot.has(slot), 'REGION_MISSING', 'Placement cannot create missing chunks.');
      requireThat(!bySlot.get(slot).external, 'REGION_EXTERNAL', 'Replacing external chunk records is not supported yet.');
    }
    outputParent = externalParent(path.dirname(path.resolve(outputFile)), [world, ...(options.worlds ?? [])]);
    file = path.join(outputParent, path.basename(outputFile)); parentStamp = fs.lstatSync(outputParent, { bigint: true });
    outputFD = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    owned = stat(outputFD); outputStamp = owned;
    write(Buffer.alloc(HEADER), 0);
    const copy = Buffer.alloc(COPY_BYTES), records = [], expected = [];
    let sector = 2, visited = 0;
    for (let slot = 0; slot < 1024; slot++) {
      check();
      const location = sourceHeader.readUInt32BE(slot * 4);
      if (!location) continue;
      const sourceOffset = (location >>> 8) * SECTOR, sourceBytes = (location & 255) * SECTOR;
      const x = regionX * 32 + slot % 32, z = regionZ * 32 + Math.floor(slot / 32);
      let count, recordHash, rawHash = null;
      if (selected.has(slot)) {
        // Scope the reader/cache and both raw records to this one chunk.
        const prepared = (() => {
          const reader = createChunkReader(world, destinationDimension), chunk = reader.read(x, z);
          requireThat(chunk, 'REGION_MISSING', 'Placement cannot create missing chunks.');
          check();
          const raw = transform({ x, z, raw: chunk.raw });
          check(); reader.verifyStable();
          requireThat(Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= MAX_RAW, 'REGION_CHUNK_SIZE', 'Transformed chunk must contain at most 32 MiB of NBT.');
          const nbt = parseNBT(raw);
          requireThat(nbt.xPos === x && nbt.zPos === z && nbt.DataVersion === chunk.nbt.DataVersion && ['full', 'minecraft:full'].includes(nbt.Status) && Array.isArray(nbt.sections),
            'REGION_CHUNK_SCHEMA', 'Transformation changed chunk position, version or required terrain schema.');
          const payload = deflateSync(raw), count = Math.ceil((payload.length + 5) / SECTOR);
          requireThat(count <= 255, 'REGION_EXTERNAL', 'New chunk requires external storage; placement is blocked.');
          return { payload, count, sha256: digest(raw) };
        })();
        count = prepared.count;
        rawHash = prepared.sha256;
        requireThat((sector + count) * SECTOR <= MAX_REGION, 'REGION_SIZE', 'Prepared region exceeds the existing 256 MiB copy-placement limit.');
        const record = Buffer.alloc(count * SECTOR); record.writeUInt32BE(prepared.payload.length + 1); record[4] = 2; prepared.payload.copy(record, 5);
        recordHash = digest(record); write(record, sector * SECTOR);
        expected.push({ x, z, sha256: prepared.sha256 });
      } else {
        count = sourceBytes / SECTOR;
        requireThat((sector + count) * SECTOR <= MAX_REGION, 'REGION_SIZE', 'Prepared region exceeds the existing 256 MiB copy-placement limit.');
        const hash = createHash('sha256');
        for (let at = 0; at < sourceBytes; at += COPY_BYTES) {
          check();
          const bytes = copy.subarray(0, Math.min(COPY_BYTES, sourceBytes - at));
          readExact(sourceFD, bytes, sourceOffset + at); hash.update(bytes); write(bytes, sector * SECTOR + at);
        }
        recordHash = hash.digest('hex');
      }
      header.writeUInt32BE(sector * 256 + count, slot * 4);
      records.push({ slot, offset: sector * SECTOR, bytes: count * SECTOR, sha256: recordHash, rawHash });
      sector += count;
      report({ phase: 'Preparing template region', regionX, regionZ, x, z, chunks: ++visited, totalChunks: inspected.present, changedChunks: expected.length, bytes: sector * SECTOR });
    }
    write(header, 0); fs.fsyncSync(outputFD); outputStamp = stat(outputFD); check();
    const actualHeader = Buffer.alloc(HEADER); readExact(outputFD, actualHeader, 0);
    requireThat(actualHeader.equals(header) && outputStamp.size === BigInt(sector * SECTOR), 'REGION_OUTPUT_CHANGED', 'Prepared region header or file size failed verification.');
    for (const record of records) {
      check(); const hash = createHash('sha256');
      for (let at = 0; at < record.bytes; at += COPY_BYTES) {
        check(); const bytes = copy.subarray(0, Math.min(COPY_BYTES, record.bytes - at));
        readExact(outputFD, bytes, record.offset + at); hash.update(bytes);
      }
      requireThat(hash.digest('hex') === record.sha256, 'REGION_OUTPUT_CHANGED', 'Prepared chunk allocation failed byte-for-byte verification.');
      if (record.rawHash) {
        // New records never exceed 255 sectors; bounded decompression checks the
        // exact written bytes independently from the transformation buffer.
        const bytes = Buffer.alloc(record.bytes); readExact(outputFD, bytes, record.offset);
        const length = bytes.readUInt32BE(0);
        requireThat(bytes[4] === 2 && length > 1 && length + 4 <= bytes.length, 'REGION_OUTPUT_CHANGED', 'Prepared chunk envelope failed verification.');
        const raw = inflateSync(bytes.subarray(5, length + 4), { maxOutputLength: MAX_RAW });
        requireThat(digest(raw) === record.rawHash, 'REGION_OUTPUT_CHANGED', 'Prepared chunk NBT failed exact-byte verification.');
      }
    }
    check();
    return { file, bytes: sector * SECTOR, changedChunks: expected.length, expected, regionX, regionZ };
  } catch (error) {
    // An exclusive file belongs to this operation. Never delete a replacement
    // inode installed by outside code at the same pathname.
    if (owned && file) {
      try { if (sameIdentity(owned, fs.lstatSync(file, { bigint: true }))) fs.unlinkSync(file); } catch {}
    }
    throw error;
  } finally {
    if (outputFD !== undefined) fs.closeSync(outputFD);
    fs.closeSync(sourceFD);
  }
}
