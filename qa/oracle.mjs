import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { parseNBT } from '../engine/nbt.js';
import { slot } from './fixtures.mjs';

// Deliberately independent of engine inventory/hash/region-reader implementations.
export function treeHashes(root) {
  const files = {};
  function walk(relative) {
    for (const item of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = path.join(relative, item.name);
      if (item.isDirectory()) walk(rel);
      else if (item.isFile()) files[rel] = createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
      else throw new Error(`Unexpected non-regular fixture entry: ${rel}`);
    }
  }
  walk(''); return files;
}
export function record(file, x, z) {
  const bytes = fs.readFileSync(file), i = slot(x, z), location = bytes.readUInt32BE(i * 4);
  if (!location) return null;
  const start = (location >>> 8) * 4096, length = bytes.readUInt32BE(start);
  if (bytes[start + 4] !== 2) throw new Error('QA oracle only handles its own zlib fixtures');
  const compressed = bytes.subarray(start + 5, start + 4 + length);
  return { timestamp: bytes.readUInt32BE(4096 + i * 4), compressed, nbt: parseNBT(inflateSync(compressed)) };
}
