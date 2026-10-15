import { gunzipSync } from 'node:zlib';
import { WorldError, requireThat } from './errors.js';

export const NBT_LIMITS = Object.freeze({ compressed: 16 * 1024 * 1024, bytes: 64 * 1024 * 1024, depth: 64, nodes: 1000000 });

// Java DataInput uses modified UTF-8: NUL and UTF-16 surrogate pairs differ from UTF-8.
export function modifiedUTF8(bytes) {
  const units = [];
  for (let i = 0; i < bytes.length;) {
    const a = bytes[i++];
    if (a > 0 && a < 128) { units.push(a); continue; }
    if ((a & 0xe0) === 0xc0) {
      const b = bytes[i++];
      requireThat(b !== undefined && (b & 0xc0) === 0x80, 'NBT_UTF8', 'Invalid modified UTF-8 string.');
      const u = ((a & 31) << 6) | (b & 63);
      requireThat(u === 0 || u >= 128, 'NBT_UTF8', 'Overlong string encoding.'); units.push(u);
    } else if ((a & 0xf0) === 0xe0) {
      const b = bytes[i++], c = bytes[i++];
      requireThat(b !== undefined && c !== undefined && (b & 0xc0) === 128 && (c & 0xc0) === 128, 'NBT_UTF8', 'Invalid modified UTF-8 string.');
      const u = ((a & 15) << 12) | ((b & 63) << 6) | (c & 63);
      requireThat(u >= 2048, 'NBT_UTF8', 'Overlong string encoding.'); units.push(u);
    } else throw new WorldError('NBT_UTF8', 'Invalid modified UTF-8 string.');
  }
  let result = ''; for (let i = 0; i < units.length; i += 4096) result += String.fromCharCode(...units.slice(i, i + 4096));
  return result;
}

/** Bounded, big-endian, named-root Java NBT. Longs remain exact decimal strings. */
export function parseNBT(input, limits = NBT_LIMITS) {
  requireThat(Buffer.isBuffer(input) && input.length <= limits.bytes, 'NBT_SIZE', 'NBT exceeds the size limit.');
  let offset = 0, nodes = 0;
  const take = n => { requireThat(n >= 0 && offset + n <= input.length, 'NBT_TRUNCATED', 'Truncated NBT data.'); const p = offset; offset += n; return p; };
  const byte = () => input.readUInt8(take(1));
  const int = () => input.readInt32BE(take(4));
  const str = () => { const n = input.readUInt16BE(take(2)); return modifiedUTF8(input.subarray(take(n), offset)); };
  function length(width = 1) { const n = int(); requireThat(n >= 0 && n <= limits.nodes && n * width <= input.length - offset, 'NBT_LENGTH', 'Invalid or excessive NBT collection length.'); return n; }
  function value(type, depth) {
    requireThat(depth <= limits.depth && ++nodes <= limits.nodes, 'NBT_LIMIT', 'NBT nesting or element limit exceeded.');
    switch (type) {
      case 1: return input.readInt8(take(1));
      case 2: return input.readInt16BE(take(2));
      case 3: return int();
      case 4: return input.readBigInt64BE(take(8)).toString();
      case 5: return input.readFloatBE(take(4));
      case 6: return input.readDoubleBE(take(8));
      case 7: { const n = length(); return input.subarray(take(n), offset); }
      case 8: return str();
      case 9: {
        const child = byte(), n = length();
        requireThat(child <= 12 && (child !== 0 || n === 0), 'NBT_TYPE', 'Invalid NBT list type.');
        return Array.from({ length: n }, () => value(child, depth + 1));
      }
      case 10: {
        const result = Object.create(null);
        for (;;) { const child = byte(); if (!child) return result; const name = str(); requireThat(!Object.hasOwn(result, name), 'NBT_DUPLICATE', 'Duplicate NBT tag.'); result[name] = value(child, depth + 1); }
      }
      case 11: { const n = length(4); return Array.from({ length: n }, int); }
      case 12: { const n = length(8); return Array.from({ length: n }, () => input.readBigInt64BE(take(8)).toString()); }
      default: throw new WorldError('NBT_TYPE', `Unsupported NBT tag ${type}.`);
    }
  }
  requireThat(byte() === 10, 'NBT_ROOT', 'Expected a Java compound NBT root. This may not be a Java save.');
  str(); const root = value(10, 0);
  requireThat(offset === input.length, 'NBT_TRAILING', 'Unexpected bytes after NBT root.');
  return root;
}

export function decodeDat(buffer) {
  requireThat(buffer.length <= NBT_LIMITS.compressed, 'NBT_SIZE', 'Metadata file exceeds the 16 MiB input limit.');
  let data = buffer;
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try { data = gunzipSync(buffer, { maxOutputLength: NBT_LIMITS.bytes }); }
    catch { throw new WorldError('NBT_GZIP', 'Invalid gzip data or metadata expands beyond 64 MiB.'); }
  }
  return parseNBT(data);
}
