import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { prepareTemplateRegion } from '../engine/template-placement-region.js';
import { parseNBT } from '../engine/nbt.js';
import { readTypedNBT, writeTypedNBT, field, setField, tag } from '../engine/typed-nbt.js';
import { nbt } from './fixtures.js';

const SECTOR = 4096, dimension = { path: '.' }, sha = bytes => createHash('sha256').update(bytes).digest('hex');
function terrain(x = 0, z = 0, extra = {}) {
  return nbt({ DataVersion: [3, 4903], xPos: [3, x], zPos: [3, z], Status: [8, 'minecraft:full'],
    sections: [9, { type: 10, values: [{ Y: [1, 0], block_states: [10, { palette: [9, { type: 10, values: [{ Name: [8, 'minecraft:stone'] }] }] }] }] }],
    block_entities: [9, { type: 10, values: [] }], block_ticks: [9, { type: 10, values: [] }], fluid_ticks: [9, { type: 10, values: [] }],
    UntouchedLong: [4, 9223372036854775807n], UntouchedBytes: [7, Buffer.from([0, 255, 3, 7])], ...extra });
}
function allocated(payload, { marker = 2, count, padding = 0x7d } = {}) {
  const external = marker & 128, length = external ? 1 : payload.length + 1;
  count ??= Math.ceil((length + 4) / SECTOR);
  const bytes = Buffer.alloc(count * SECTOR, padding); bytes.writeUInt32BE(length); bytes[4] = marker;
  if (!external) payload.copy(bytes, 5);
  return bytes;
}
function fixture(t, { rx = 0, rz = 0, records } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worldrenew-template-region-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'world'), regionDir = path.join(root, 'region'); fs.mkdirSync(regionDir, { recursive: true }); fs.writeFileSync(path.join(root, 'level.dat'), 'generated fixture only');
  records ??= new Map([[0, allocated(deflateSync(terrain(rx * 32, rz * 32)))], [3, allocated(Buffer.from('opaque unsupported LZ4 payload'), { marker: 4, count: 2 })], [34, allocated(Buffer.alloc(0), { marker: 130 })]]);
  // Deliberately out-of-slot order and unused holes exercise relocation, while
  // timestamps for even empty slots must survive exactly.
  const header = Buffer.alloc(8192), chunks = [Buffer.alloc(SECTOR, 0xac)]; let sector = 3;
  for (let slot = 0; slot < 1024; slot++) header.writeUInt32BE(1234000 + slot, 4096 + slot * 4);
  for (const [slot, bytes] of [...records].reverse()) {
    header.writeUInt32BE(sector * 256 + bytes.length / SECTOR, slot * 4); chunks.push(bytes); sector += bytes.length / SECTOR;
    if (bytes[4] & 128) fs.writeFileSync(path.join(regionDir, `c.${rx * 32 + slot % 32}.${rz * 32 + Math.floor(slot / 32)}.mcc`), Buffer.from('opaque external payload preserved by outer copy'));
  }
  const file = path.join(regionDir, `r.${rx}.${rz}.mca`); fs.writeFileSync(file, Buffer.concat([header, ...chunks]));
  return { dir, root, file, output: path.join(dir, 'prepared.mca'), rx, rz, records };
}
function invoke(f, slots = new Set([0]), transform = ({ raw }) => raw, options = {}) {
  return prepareTemplateRegion(f.root, dimension, f.rx, f.rz, f.output, slots, transform, options);
}
function recordAt(file, slot) {
  const bytes = fs.readFileSync(file), loc = bytes.readUInt32BE(slot * 4); return bytes.subarray((loc >>> 8) * SECTOR, ((loc >>> 8) + (loc & 255)) * SECTOR);
}
function decodedAt(file, slot) {
  const bytes = recordAt(file, slot); return inflateSync(bytes.subarray(5, bytes.readUInt32BE(0) + 4));
}

test('region preparation preserves every untouched allocation, padding, timestamp and source byte', t => {
  const f = fixture(t), before = fs.readFileSync(f.file), progress = [];
  const result = invoke(f, new Set([0]), ({ raw }) => {
    const tree = readTypedNBT(raw), section = field(tree, 'sections').value[0];
    setField(section, 'block_states', { type: 10, value: [{ name: 'palette', type: 9, elementType: 10, value: [{ type: 10, value: [{ name: 'Name', ...tag(8, 'minecraft:oak_planks') }] }] }] });
    return writeTypedNBT(tree);
  }, { onProgress: value => progress.push(value) });
  assert.deepEqual(fs.readFileSync(f.file), before);
  for (const slot of [3, 34]) assert.deepEqual(recordAt(result.file, slot), f.records.get(slot));
  const after = fs.readFileSync(result.file);
  assert.deepEqual(after.subarray(4096, 8192), before.subarray(4096, 8192));
  const raw = decodedAt(result.file, 0), nbt = parseNBT(raw);
  assert.equal(nbt.sections[0].block_states.palette[0].Name, 'minecraft:oak_planks');
  assert.equal(nbt.UntouchedLong, '9223372036854775807'); assert.deepEqual(nbt.UntouchedBytes, Buffer.from([0, 255, 3, 7]));
  assert.equal(result.changedChunks, 1); assert.deepEqual(result.expected, [{ x: 0, z: 0, sha256: sha(raw) }]);
  assert.equal(result.bytes, after.length); assert.ok(after.length < before.length); assert.equal(progress.length, 3);
  assert.equal(fs.statSync(result.file).mode & 0o777, 0o600);
});

test('negative region coordinates and the final slot preserve exact transformed raw records', t => {
  const raw = terrain(-1, -33), f = fixture(t, { rx: -1, rz: -2, records: new Map([[1023, allocated(raw, { marker: 3 })]]) });
  const result = invoke(f, new Set([1023]));
  assert.deepEqual(decodedAt(result.file, 1023), raw); assert.deepEqual(result.expected, [{ x: -1, z: -33, sha256: sha(raw) }]);
});

test('unselected opaque/external records are never decompressed or transformed', t => {
  const f = fixture(t); let called = false;
  const result = invoke(f, new Set(), () => { called = true; throw Error('must not decode'); });
  assert.equal(called, false); assert.equal(result.changedChunks, 0); assert.deepEqual(result.expected, []);
  for (const [slot, record] of f.records) assert.deepEqual(recordAt(result.file, slot), record);
});

test('external targets, absent chunks and invalid slot indices fail before output creation', t => {
  const f = fixture(t);
  for (const [slots, code] of [[new Set([34]), 'REGION_EXTERNAL'], [new Set([1]), 'REGION_MISSING'], [new Set([1024]), 'REGION_SLOTS'], [new Set([0.5]), 'REGION_SLOTS']]) {
    assert.throws(() => invoke(f, slots), { code }); assert.equal(fs.existsSync(f.output), false);
  }
});

test('unknown target compression, malformed raw and transform schema changes never become air', t => {
  const f = fixture(t);
  assert.throws(() => invoke(f, new Set([3])), { code: 'CHUNK_COMPRESSION' }); assert.equal(fs.existsSync(f.output), false);
  for (const raw of [Buffer.from('not NBT'), terrain(1, 0), nbt({})]) {
    assert.throws(() => invoke(f, new Set([0]), () => raw)); assert.equal(fs.existsSync(f.output), false);
  }
});

test('raw size, compressed sector limits and original region limits remain strict', t => {
  const f = fixture(t);
  assert.throws(() => invoke(f, new Set([0]), () => Buffer.alloc(32 * 1024 * 1024 + 1)), { code: 'REGION_CHUNK_SIZE' }); assert.equal(fs.existsSync(f.output), false);
  const large = terrain(0, 0, { RandomA: [7, randomBytes(600000)], RandomB: [7, randomBytes(600000)] });
  assert.throws(() => invoke(f, new Set([0]), () => large), { code: 'REGION_EXTERNAL' }); assert.equal(fs.existsSync(f.output), false);
  fs.truncateSync(f.file, 256 * 1024 * 1024 + SECTOR);
  assert.throws(() => invoke(f), { code: 'REGION_SIZE' }); assert.equal(fs.existsSync(f.output), false);
});

test('decompression expansion limit rejects a compressed oversized source', t => {
  const f = fixture(t, { records: new Map([[0, allocated(deflateSync(Buffer.alloc(32 * 1024 * 1024 + 1)))]] ) });
  assert.throws(() => invoke(f), { code: 'CHUNK_DECOMPRESSION' }); assert.equal(fs.existsSync(f.output), false);
});

test('overlapping allocations are rejected and no prepared output is created', t => {
  const f = fixture(t), bytes = fs.readFileSync(f.file); bytes.writeUInt32BE(bytes.readUInt32BE(0), 4); fs.writeFileSync(f.file, bytes);
  assert.throws(() => invoke(f), { code: 'REGION_ALLOCATION' }); assert.equal(fs.existsSync(f.output), false);
});

test('cancellation and throwing progress callbacks remove prepared output and preserve source', t => {
  const f = fixture(t), before = fs.readFileSync(f.file), controller = new AbortController();
  assert.throws(() => invoke(f, new Set([0]), undefined, { signal: controller.signal, onProgress: () => controller.abort() }), { code: 'TEMPLATE_CANCELLED' });
  assert.equal(fs.existsSync(f.output), false); assert.deepEqual(fs.readFileSync(f.file), before);
  assert.throws(() => invoke(f, new Set([0]), undefined, { onProgress: () => { throw Error('callback failure'); } }), /callback failure/);
  assert.equal(fs.existsSync(f.output), false); assert.deepEqual(fs.readFileSync(f.file), before);
  assert.throws(() => invoke(f, new Set([0]), undefined, { shouldCancel: () => true }), { code: 'TEMPLATE_CANCELLED' }); assert.equal(fs.existsSync(f.output), false);
});

test('source content or identity mutations in callbacks block preparation', t => {
  for (const replace of [false, true]) {
    const f = fixture(t);
    assert.throws(() => invoke(f, new Set([0]), undefined, { onProgress: () => {
      const bytes = fs.readFileSync(f.file); bytes[bytes.length - 1] ^= 1;
      if (replace) { const other = `${f.file}.replacement`; fs.writeFileSync(other, bytes); fs.renameSync(other, f.file); }
      else fs.writeFileSync(f.file, bytes);
    } }), { code: 'REGION_CHANGED' });
    assert.equal(fs.existsSync(f.output), false);
  }
});

test('output content mutation in transform/progress/cancellation callbacks is rejected and cleaned up', t => {
  for (const hook of ['transform', 'onProgress', 'shouldCancel']) {
    const f = fixture(t); let changed = false;
    const mutate = () => {
      if (!changed && fs.existsSync(f.output)) { changed = true; const fd = fs.openSync(f.output, 'r+'); fs.writeSync(fd, Buffer.from([9]), 0, 1, 0); fs.closeSync(fd); }
      return false;
    };
    const options = hook === 'transform' ? {} : { [hook]: mutate };
    assert.throws(() => invoke(f, new Set([0]), hook === 'transform' ? ({ raw }) => { mutate(); return raw; } : undefined, options), { code: 'REGION_OUTPUT_CHANGED' });
    assert.equal(fs.existsSync(f.output), false);
  }
});

test('output identity replacement is rejected without deleting the replacing file', t => {
  const f = fixture(t), sentinel = Buffer.from('another file at the same path');
  assert.throws(() => invoke(f, new Set([0]), undefined, { onProgress: () => {
    const replacement = path.join(f.dir, 'replacement'); fs.writeFileSync(replacement, sentinel); fs.renameSync(replacement, f.output);
  } }), { code: 'REGION_OUTPUT_CHANGED' });
  assert.deepEqual(fs.readFileSync(f.output), sentinel);
});

test('cancellation during written-record verification removes the complete prepared file', t => {
  const f = fixture(t), before = fs.readFileSync(f.file); let verifying = false;
  assert.throws(() => invoke(f, new Set([0]), undefined, { shouldCancel: () => {
    if (fs.existsSync(f.output) && fs.statSync(f.output).size >= 8192) {
      const fd = fs.openSync(f.output, 'r'), location = Buffer.alloc(4); fs.readSync(fd, location, 0, 4, 0); fs.closeSync(fd);
      if (location.readUInt32BE(0)) { verifying = true; return true; }
    }
    return false;
  } }), { code: 'TEMPLATE_CANCELLED' });
  assert.equal(verifying, true); assert.equal(fs.existsSync(f.output), false); assert.deepEqual(fs.readFileSync(f.file), before);
});

test('existing outputs, world-local outputs and unsafe source paths are never overwritten', t => {
  const f = fixture(t), existing = Buffer.from('existing output'); fs.writeFileSync(f.output, existing);
  assert.throws(() => invoke(f), { code: 'EEXIST' }); assert.deepEqual(fs.readFileSync(f.output), existing);
  assert.throws(() => invoke({ ...f, output: path.join(f.root, 'new.mca') }), { code: 'ARCHIVE_IN_WORLD' }); assert.equal(fs.existsSync(path.join(f.root, 'new.mca')), false);
  const otherWorld = path.join(f.dir, 'other-world'); fs.mkdirSync(otherWorld);
  assert.throws(() => invoke({ ...f, output: path.join(otherWorld, 'new.mca') }, new Set([0]), undefined, { worlds: [otherWorld] }), { code: 'ARCHIVE_IN_WORLD' });
  fs.renameSync(f.file, `${f.file}.original`); fs.symlinkSync(`${f.file}.original`, f.file);
  assert.throws(() => invoke({ ...f, output: path.join(f.dir, 'new.mca') }), { code: 'SYMLINK' });
});

test('large untouched allocations are preserved without retaining a region-size buffer', t => {
  const records = new Map([[0, allocated(deflateSync(terrain()))]]);
  for (let slot = 1; slot <= 40; slot++) records.set(slot, allocated(Buffer.from(`opaque ${slot}`), { marker: 4, count: 255, padding: slot }));
  const f = fixture(t, { records });
  const result = invoke(f);
  assert.equal(result.bytes, (3 + 40 * 255) * SECTOR);
  for (const slot of [1, 17, 40]) assert.equal(sha(recordAt(result.file, slot)), sha(records.get(slot)));
  assert.equal(result.changedChunks, 1);
});
