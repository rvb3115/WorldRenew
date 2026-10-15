import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { parseNBT, decodeDat, NBT_LIMITS } from '../engine/nbt.js';
import { inspectRegion } from '../engine/anvil.js';
import { inspectWorld } from '../engine/world.js';
import { saveProject, loadProject, projectFilename } from '../engine/projects.js';
import { createVerifiedCopy, executeDestructiveOperation } from '../engine/safety.js';
import { previewRegeneration } from '../engine/plans.js';
import { versionPolicy } from '../engine/versions.js';
import { nbt, tag, i32, makeWorld, writeRegion, writeDat } from './fixtures.js';

function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worldrenew-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function fixture(t, options) { const base = temp(t); return { base, root: makeWorld(path.join(base, 'world'), options) }; }
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function treeHashes(root) {
  const result = {}; for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) if (entry.isFile()) { const p = path.join(entry.parentPath, entry.name); result[path.relative(root, p)] = hash(p); } return result;
}

test('NBT reads all tags, modified UTF-8, and precise signed 64-bit seeds', () => {
  const data = parseNBT(nbt({ byte: [1, -2], short: [2, -32768], int: [3, 42], long: [4, -9223372036854775808n], float: [5, 1.5], double: [6, 2.25], bytes: [7, [1, 255]], text: [8, 'Hello\u0000🌲'], list: [9, { type: 3, values: [1, 2] }], empty: [9, { type: 0, values: [] }], object: [10, { yes: [1, 1] }], ints: [11, [-1, 2]], longs: [12, [9223372036854775807n]] }));
  assert.equal(data.long, '-9223372036854775808'); assert.equal(data.text, 'Hello\u0000🌲'); assert.deepEqual(data.list, [1, 2]); assert.equal(data.object.yes, 1); assert.deepEqual(data.ints, [-1, 2]); assert.equal(data.longs[0], '9223372036854775807'); assert.equal(data.short, -32768); assert.equal(data.float, 1.5); assert.equal(data.double, 2.25); assert.equal(data.bytes[1], 255); assert.equal(Object.getPrototypeOf(data), null);
});
test('gzip and uncompressed metadata are accepted', () => { const b = nbt({ value: [3, 9] }); assert.equal(decodeDat(b).value, 9); assert.equal(decodeDat(gzipSync(b)).value, 9); });
test('truncation, trailing bytes, bad tag types and gzip are rejected', () => {
  const b = nbt({ a: [3, 1] }); assert.throws(() => parseNBT(b.subarray(0, -1)), /Truncated/); assert.throws(() => parseNBT(Buffer.concat([b, Buffer.from([0])])), /Unexpected bytes/);
  assert.throws(() => parseNBT(Buffer.from([10, 0, 0, 99, 0, 0, 0])), /Unsupported/); assert.throws(() => decodeDat(Buffer.from([31, 139, 0])), /gzip/);
});
test('NBT rejects hostile lengths, depth, duplicate tags and decompression bombs', () => {
  assert.throws(() => parseNBT(Buffer.concat([Buffer.from([10, 0, 0, 7, 0, 0]), i32(-1), Buffer.from([0])])), /length/);
  let data = {}; for (let i = 0; i < 70; i++) data = { nested: [10, data] }; assert.throws(() => parseNBT(nbt(data)), /nesting/);
  assert.throws(() => parseNBT(Buffer.concat([Buffer.from([10, 0, 0]), tag(3, 'same', 1), tag(3, 'same', 2), Buffer.from([0])])), /Duplicate/);
  assert.throws(() => decodeDat(gzipSync(Buffer.alloc(NBT_LIMITS.bytes + 1))), /64 MiB/);
});
test('NBT prototype-like names remain inert data', () => { const d = parseNBT(Buffer.concat([Buffer.from([10, 0, 0]), tag(8, '__proto__', 'safe'), Buffer.from([0])])); assert.equal(d.__proto__, 'safe'); assert.equal(Object.getPrototypeOf(d), null); });
test('26.3 namespaced dimensions, separate seed and metadata are discovered without writes', t => {
  const { root } = fixture(t), before = treeHashes(root), world = inspectWorld(root);
  assert.equal(world.metadata.name, 'Test World 🌲'); assert.equal(world.metadata.version, '26.3'); assert.equal(world.metadata.dataVersion, 999999); assert.equal(world.metadata.seed, '-9223372036854775807');
  assert.equal(world.totals.chunks, 5); assert.equal(world.totals.regions, 6); assert.equal(world.dimensions.length, 3); assert.equal(world.metadata.policy.status, 'baseline'); assert.deepEqual(treeHashes(root), before);
});
test('legacy dimensions and legacy seed are inspected as best-effort', t => { const { root } = fixture(t, { legacy: true, version: '1.21.11' }); const w = inspectWorld(root); assert.equal(w.totals.chunks, 5); assert.equal(w.metadata.seed, '-9223372036854775807'); assert.equal(w.metadata.policy.status, 'legacy'); assert.ok(w.dimensions.every(d => d.layout === 'legacy')); });
test('nested custom dimensions and duplicate layouts remain separate', t => {
  const { root } = fixture(t); writeRegion(path.join(root, 'dimensions/example/moon/deep/region/r.0.0.mca')); writeRegion(path.join(root, 'region/r.0.0.mca'));
  const w = inspectWorld(root); assert.ok(w.dimensions.some(d => d.id === 'example:moon/deep')); assert.equal(w.dimensions.filter(d => d.id === 'minecraft:overworld').length, 2); assert.ok(w.issues.some(i => i.includes('Multiple storage')));
});
test('invalid folders and Bedrock-like metadata fail usefully', t => { const root = temp(t); assert.throws(() => inspectWorld(root), /Choose the Java world/); writeDat(path.join(root, 'level.dat'), { foo: [1, 1] }); assert.throws(() => inspectWorld(root), /no Data compound/); });
test('missing seed is reported, not fabricated', t => { const { root } = fixture(t); fs.unlinkSync(path.join(root, 'data/minecraft/world_gen_settings.dat')); const w = inspectWorld(root); assert.equal(w.metadata.seed, null); assert.ok(w.issues.some(i => i.includes('Seed was not found'))); });
test('future and snapshot versions are not certified', () => { assert.equal(versionPolicy('27.1', false).status, 'future'); assert.equal(versionPolicy('26.3-snapshot-1', true).status, 'unverified'); assert.equal(versionPolicy('26.2', false).status, 'legacy'); });
test('Anvil chunk coordinates include negative region offsets', t => { const root = temp(t); writeRegion(path.join(root, 'r.-2.-1.mca'), [{ x: -33, z: -1 }]); const r = inspectRegion(root, 'r.-2.-1.mca'); assert.deepEqual([r.chunks[0].x, r.chunks[0].z], [-33, -1]); assert.equal(r.valid, 1); });
test('Anvil catches truncated headers and invalid allocations', t => {
  const root = temp(t); fs.writeFileSync(path.join(root, 'r.0.0.mca'), Buffer.alloc(100)); assert.throws(() => inspectRegion(root, 'r.0.0.mca'), /header/);
  const b = writeRegion(path.join(root, 'r.0.0.mca')); b.writeUInt32BE((30 << 8) | 1, 0); fs.writeFileSync(path.join(root, 'r.0.0.mca'), b); assert.equal(inspectRegion(root, 'r.0.0.mca').invalid, 1);
});
test('zero-byte region files are empty without writing headers', t => {
  const root = temp(t), file = path.join(root, 'r.0.0.mca'); fs.writeFileSync(file, Buffer.alloc(0));
  const before = fs.statSync(file), r = inspectRegion(root, 'r.0.0.mca');
  assert.equal(r.uninitialized, true); assert.equal(r.present, 0); assert.equal(r.invalid, 0); assert.deepEqual(r.issues, []); assert.deepEqual(r.chunks, []);
  const after = fs.statSync(file); assert.equal(after.size, 0); assert.equal(after.mtimeMs, before.mtimeMs);
});
test('nonempty partial region headers still fail even when all bytes are zero', t => {
  const root = temp(t);
  for (const size of [1, 4096, 8191]) {
    fs.writeFileSync(path.join(root, 'r.0.0.mca'), Buffer.alloc(size));
    assert.throws(() => inspectRegion(root, 'r.0.0.mca'), /Anvil header/);
  }
});
test('empty terrain, entity and POI regions survive verified copies exactly', t => {
  const { root, base } = fixture(t);
  for (const store of ['region', 'entities', 'poi']) fs.writeFileSync(path.join(root, 'dimensions/minecraft/overworld', store, 'r.20.20.mca'), Buffer.alloc(0));
  const before = treeHashes(root), report = inspectWorld(root);
  assert.equal(report.totals.chunks, 5); assert.equal(report.totals.emptyRegionFiles, 3);
  assert.ok(report.dimensions.every(d => d.issues.length === 0)); assert.ok(report.issues.some(i => i.includes('3 zero-byte')));
  const copy = createVerifiedCopy(root, base, { confirmedClosed: true });
  assert.deepEqual(treeHashes(copy.world), before); assert.deepEqual(treeHashes(root), before);
  assert.equal(inspectWorld(copy.world).totals.emptyRegionFiles, 3);
});
test('Anvil overlap marks both records invalid', t => { const root = temp(t), b = writeRegion(path.join(root, 'r.0.0.mca'), [{ x: 0, z: 0 }, { x: 1, z: 0 }]); b.writeUInt32BE(b.readUInt32BE(0), 4); fs.writeFileSync(path.join(root, 'r.0.0.mca'), b); assert.equal(inspectRegion(root, 'r.0.0.mca').invalid, 2); });
test('Anvil rejects oversized lengths and unknown compression', t => { const root = temp(t), b = writeRegion(path.join(root, 'r.0.0.mca')); b.writeUInt32BE(9000, 8192); b[8196] = 98; fs.writeFileSync(path.join(root, 'r.0.0.mca'), b); const r = inspectRegion(root, 'r.0.0.mca'); assert.equal(r.invalid, 1); assert.equal(r.chunks[0].issues.length, 2); });
test('Anvil external .mcc payload must exist', t => { const root = temp(t), b = writeRegion(path.join(root, 'r.0.0.mca')); b.writeUInt32BE(1, 8192); b[8196] = 130; fs.writeFileSync(path.join(root, 'r.0.0.mca'), b); assert.equal(inspectRegion(root, 'r.0.0.mca').invalid, 1); fs.writeFileSync(path.join(root, 'c.0.0.mcc'), Buffer.from([1, 2])); assert.equal(inspectRegion(root, 'r.0.0.mca').valid, 1); });
test('unsafe metadata symlinks are rejected and region symlinks are reported', t => {
  const { root, base } = fixture(t);
  fs.symlinkSync(path.join(root, 'dimensions/minecraft/overworld/region/r.0.0.mca'), path.join(root, 'dimensions/minecraft/overworld/region/r.1.0.mca'));
  assert.ok(inspectWorld(root).dimensions.some(d => d.issues.some(i => i.includes('Skipped unsafe'))));
  fs.renameSync(path.join(root, 'level.dat'), path.join(base, 'level.dat')); fs.symlinkSync(path.join(base, 'level.dat'), path.join(root, 'level.dat')); assert.throws(() => inspectWorld(root), /Symbolic links/);
});
test('empty chunk payloads and coordinate aliases are rejected', t => {
  const root = temp(t), b = writeRegion(path.join(root, 'r.0.0.mca')); b.writeUInt32BE(1, 8192); fs.writeFileSync(path.join(root, 'r.0.0.mca'), b);
  assert.equal(inspectRegion(root, 'r.0.0.mca').invalid, 1);
  fs.copyFileSync(path.join(root, 'r.0.0.mca'), path.join(root, 'r.00.0.mca')); assert.throws(() => inspectRegion(root, 'r.00.0.mca'), /Noncanonical/);
});
test('protection round trips outside the save and affects previews', t => {
  const { root, base } = fixture(t), before = treeHashes(root), w = inspectWorld(root), dim = w.dimensions.find(d => d.id === 'minecraft:overworld');
  const one = { dimension: dim.key, x: 0, z: 0 }, two = { dimension: dim.key, x: 1, z: 0 };
  saveProject(path.join(base, 'projects'), w, [one, one]); const loaded = loadProject(path.join(base, 'projects'), w); assert.equal(loaded.protection.length, 1);
  const plan = previewRegeneration(w, [one, two], loaded.protection); assert.deepEqual(plan.candidates, [two]); assert.deepEqual(plan.excludedProtected, [one]); assert.equal(plan.executable, false); assert.deepEqual(treeHashes(root), before);
});
test('project storage inside the save is blocked, including symlink aliases', t => { const { root, base } = fixture(t), w = inspectWorld(root); assert.throws(() => saveProject(path.join(root, 'project/new'), w, []), /outside/); assert.equal(fs.existsSync(path.join(root, 'project')), false); fs.symlinkSync(root, path.join(base, 'alias')); assert.throws(() => saveProject(path.join(base, 'alias/new'), w, []), /outside/); });
test('invalid protection entries and project schemas are rejected', t => { const { root, base } = fixture(t), w = inspectWorld(root), dir = path.join(base, 'projects'); assert.throws(() => saveProject(dir, w, [{ dimension: 'bad', x: 0, z: 0 }]), /does not exist/); saveProject(dir, w, []); fs.writeFileSync(path.join(dir, projectFilename(w)), '{"schemaVersion":999}'); assert.throws(() => loadProject(dir, w), /schema/); });
test('stale metadata and missing protected chunks produce explicit warnings', t => {
  const { root, base } = fixture(t), w = inspectWorld(root), dim = w.dimensions.find(d => d.id === 'minecraft:overworld'), dir = path.join(base, 'projects');
  saveProject(dir, w, [{ dimension: dim.key, x: 0, z: 0 }]);
  const changed = structuredClone(w); changed.fingerprint = 'changed'; changed.dimensions = [];
  const p = loadProject(dir, changed); assert.equal(p.protection.length, 0); assert.equal(p.warnings.length, 2);
});
test('verified copy preserves source and every copied file; manifest stays outside world', t => {
  const { root, base } = fixture(t), before = treeHashes(root); const result = createVerifiedCopy(root, base, { confirmedClosed: true });
  assert.deepEqual(treeHashes(root), before); assert.deepEqual(treeHashes(result.world), before); assert.equal(fs.existsSync(path.join(result.world, 'manifest.json')), false);
  const manifest = JSON.parse(fs.readFileSync(result.manifest)); assert.equal(manifest.files.length, Object.keys(before).length); for (const file of manifest.files) assert.equal(file.sha256, before[file.path]);
});
test('copy requires closed-world acknowledgement and rejects destination in a save', t => { const { root, base } = fixture(t); assert.throws(() => createVerifiedCopy(root, base), /fully closed/); assert.throws(() => createVerifiedCopy(root, root, { confirmedClosed: true }), /outside/); });
test('copy rejects links and structurally corrupt sources', t => {
  const { root, base } = fixture(t); fs.symlinkSync(path.join(root, 'level.dat'), path.join(root, 'linked')); assert.throws(() => createVerifiedCopy(root, base, { confirmedClosed: true }), /links/); fs.unlinkSync(path.join(root, 'linked'));
  fs.writeFileSync(path.join(root, 'dimensions/minecraft/overworld/region/r.0.0.mca'), Buffer.alloc(1)); assert.throws(() => createVerifiedCopy(root, base, { confirmedClosed: true }), /Structural validation/);
});
test('copy detects concurrent changes and removes only its staging folder', t => {
  const { root, base } = fixture(t); let changed = false;
  assert.throws(() => createVerifiedCopy(root, base, { confirmedClosed: true }, progress => { if (!changed && progress.phase === 'Copying and verifying') { changed = true; fs.writeFileSync(path.join(root, 'new-file'), 'changed'); } }), /Source changed/);
  assert.equal(fs.readdirSync(base).some(f => f.includes('.partial')), false); assert.ok(fs.existsSync(path.join(root, 'new-file')));
});
test('destructive operations fail closed even with a forged backup argument', () => { assert.throws(() => executeDestructiveOperation({ verified: true }), {code:'WRITES_DISABLED'}); });
