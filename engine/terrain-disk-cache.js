import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { projectDirectoryOutsideWorld } from './projects.js';
import { readBounded } from './paths.js';
import { TERRAIN_SUMMARY_SCHEMA } from './terrain-summary.js';

export const TERRAIN_DISK_BYTES = 128 * 1024 * 1024;
export const TERRAIN_DISK_FILES = 32768;
const MAX_FILE = 65536;
const hash = data => createHash('sha256').update(data).digest('hex');
const filename = /^[a-f0-9]{64}\.json$/;

/** Disposable, bounded, atomic cache outside saves. Failure only loses acceleration. */
export class TerrainDiskCache {
  constructor(directory, world, { maxBytes = TERRAIN_DISK_BYTES, maxFiles = TERRAIN_DISK_FILES } = {}) {
    this.maxBytes = maxBytes; this.maxFiles = maxFiles; this.files = new Map(); this.bytes = 0; this.warning = '';
    try {
      this.directory = projectDirectoryOutsideWorld(directory, world);
      fs.mkdirSync(this.directory, { recursive: true });
      // Never follow a cache-file symlink, or erase unrelated files.
      for (const e of fs.readdirSync(this.directory, { withFileTypes: true })) {
        if (!filename.test(e.name) || !e.isFile()) continue;
        const s = fs.lstatSync(path.join(this.directory, e.name));
        this.files.set(e.name, { bytes: s.size, time: s.mtimeMs }); this.bytes += s.size;
      }
      this.trim();
    } catch (error) { this.directory = null; this.warning = `Disk terrain cache unavailable: ${error.message}`; }
  }
  name(identity) { return `${hash(identity)}.json`; }
  trim(extra = 0, extraFiles = 0) {
    if (this.bytes + extra <= this.maxBytes && this.files.size + extraFiles <= this.maxFiles) return;
    for (const [name, stat] of [...this.files].sort((a,b)=>a[1].time-b[1].time)) {
      fs.unlinkSync(path.join(this.directory, name)); this.files.delete(name); this.bytes -= stat.bytes;
      if (this.bytes + extra <= this.maxBytes && this.files.size + extraFiles <= this.maxFiles) break;
    }
  }
  read(identity, sourceStamp) {
    if (!this.directory) return null;
    const name = this.name(identity);
    try {
      const data = JSON.parse(readBounded(this.directory, name, MAX_FILE));
      if (data.schema !== TERRAIN_SUMMARY_SCHEMA || data.identity !== identity || data.sourceStamp !== sourceStamp || !Array.isArray(data.entries) || data.entries.length > 1024 || data.digest !== hash(JSON.stringify(data.entries))) return null;
      const seen = new Set();
      for (const e of data.entries) {
        if (!Array.isArray(e) || e.length !== 3 || !Number.isInteger(e[0]) || e[0] < 0 || e[0] >= 1024 || seen.has(e[0]) || !Number.isInteger(e[1]) || e[1] < 1 || e[1] > 5 || !Number.isInteger(e[2]) || e[2] < 0 || e[2] > 0xffffff) return null;
        seen.add(e[0]);
      }
      const now = Date.now(); if (this.files.has(name)) this.files.get(name).time = now;
      fs.utimesSync(path.join(this.directory, name), new Date(now), new Date(now));
      return data.entries;
    } catch { return null; }
  }
  write(identity, sourceStamp, entries) {
    if (!this.directory) return;
    let temp;
    try {
      const data = JSON.stringify({ schema: TERRAIN_SUMMARY_SCHEMA, identity, sourceStamp, entries, digest: hash(JSON.stringify(entries)) });
      const bytes = Buffer.byteLength(data), name = this.name(identity), old = this.files.get(name);
      if (bytes > MAX_FILE || bytes > this.maxBytes) return;
      this.trim(Math.max(0,bytes-(old?.bytes??0)), old ? 0 : 1);
      temp = path.join(this.directory, `.${randomUUID()}.tmp`);
      fs.writeFileSync(temp, data, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, path.join(this.directory, name));
      this.bytes -= this.files.get(name)?.bytes??0;
      this.files.set(name, { bytes, time: Date.now() }); this.bytes += bytes;
    } catch (error) { this.warning = `Terrain cache could not be saved: ${error.message}`; }
    finally { if (temp) { try { fs.unlinkSync(temp); } catch {} } }
  }
  get stats() { return { bytes: this.bytes, files: this.files.size, maxBytes: this.maxBytes, maxFiles: this.maxFiles, warning: this.warning }; }
}
