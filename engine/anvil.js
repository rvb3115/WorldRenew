import fs from 'node:fs';
import path from 'node:path';
import { safePath } from './paths.js';
import { requireThat } from './errors.js';

export const REGION_NAME = /^r\.(-?\d+)\.(-?\d+)\.mca$/;

/** Inspect location/timestamp tables and record envelopes; never decompress or alter chunks. */
export function inspectRegion(root, relative, { includeChunks = true } = {}) {
  const match = REGION_NAME.exec(path.basename(relative));
  requireThat(match, 'REGION_NAME', 'Invalid Anvil region filename.');
  const rx = Number(match[1]), rz = Number(match[2]);
  requireThat(Number.isSafeInteger(rx * 32 + 31) && Number.isSafeInteger(rz * 32 + 31), 'REGION_COORD', 'Region coordinates exceed safe integer range.');
  requireThat(String(rx) === match[1] && String(rz) === match[2], 'REGION_COORD', 'Noncanonical region coordinates could alias another region.');
  const file = safePath(root, relative), fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd), issues = [], entries = [];
    const sourceStamp = { bytes: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino };
    requireThat(stat.isFile(), 'REGION_HEADER', 'Region is not a regular file.');
    // Vanilla RegionFile treats immediate EOF as an uninitialized, empty region.
    // Do not write an empty header as Minecraft's mutating initializer might do.
    if (stat.size === 0) return { path: relative, sourceStamp, rx, rz, bytes: 0, present: 0, valid: 0, invalid: 0, uninitialized: true, issues: [], chunks: [] };
    requireThat(stat.size >= 8192, 'REGION_HEADER', 'Missing 8 KiB Anvil header.');
    if (stat.size % 4096) issues.push('File size is not sector aligned.');
    const header = Buffer.alloc(8192);
    requireThat(fs.readSync(fd, header, 0, 8192, 0) === 8192, 'REGION_HEADER', 'Incomplete Anvil header.');
    const sectors = new Map(); let present = 0;
    for (let i = 0; i < 1024; i++) {
      const loc = header.readUInt32BE(i * 4), sector = loc >>> 8, count = loc & 255;
      if (loc === 0) continue;
      present++;
      const chunk = { x: rx * 32 + i % 32, z: rz * 32 + Math.floor(i / 32), timestamp: header.readUInt32BE(4096 + i * 4), valid: true, external: false, compression: null, issues: [] };
      const fail = message => { chunk.valid = false; chunk.issues.push(message); };
      if (sector < 2 || count === 0 || (sector + count) * 4096 > stat.size) fail('Invalid sector allocation or truncated chunk.');
      else {
        for (let s = sector; s < sector + count; s++) {
          if (sectors.has(s)) { const other = sectors.get(s); other.valid = false; if (!other.issues.includes('Overlapping sector allocation.')) other.issues.push('Overlapping sector allocation.'); fail('Overlapping sector allocation.'); }
          else sectors.set(s, chunk);
        }
        const envelope = Buffer.alloc(5);
        if (fs.readSync(fd, envelope, 0, 5, sector * 4096) !== 5) fail('Truncated chunk envelope.');
        else {
          const length = envelope.readUInt32BE(0), marker = envelope[4];
          chunk.compression = marker & 127; chunk.external = Boolean(marker & 128);
          if (length < 1 || length + 4 > count * 4096) fail('Chunk length exceeds allocation.');
          if (!chunk.external && length === 1) fail('Chunk payload is empty.');
          if (![1, 2, 3, 4].includes(chunk.compression)) fail('Unknown chunk compression marker.');
          if (chunk.external) {
            if (length !== 1) fail('External chunk stub has unexpected length.');
            try { const ext = safePath(root, path.join(path.dirname(relative), `c.${chunk.x}.${chunk.z}.mcc`)); if (!fs.statSync(ext).isFile() || fs.statSync(ext).size === 0) fail('External chunk payload is empty or not a regular file.'); }
            catch { fail('External chunk payload is missing or unsafe.'); }
          }
        }
      }
      entries.push(chunk);
    }
    const after = fs.fstatSync(fd);
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) issues.push('Region changed during inspection. Close Minecraft and rescan.');
    const invalid = entries.filter(c => !c.valid).length;
    if (invalid) issues.push(`${invalid} chunk allocation(s) failed structural checks.`);
    return { path: relative, sourceStamp, rx, rz, bytes: stat.size, present, valid: present - invalid, invalid, uninitialized: false, issues, chunks: includeChunks ? entries : [] };
  } finally { fs.closeSync(fd); }
}
