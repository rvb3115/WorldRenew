import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeWorld, writeRegion, emptyRecordTags, nbt } from './fixtures.js';
import { gzipSync, deflateSync } from 'node:zlib';
import { inspectWorld } from '../engine/world.js';
import { inspectRegion } from '../engine/anvil.js';
import { createRegenerationReview } from '../engine/regeneration.js';
import { createRegeneratedCopy } from '../engine/regeneration-export.js';
import { hashFile, inventory } from '../engine/safety.js';

const acknowledgements = { confirmedClosed: true, confirmedExperimental: true };
const hashTree = root => inventory(root).files.map(f => ({ ...f, sha256: hashFile(path.join(root, f.path)) }));
function setup(t, options) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'worldrenew-export-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = makeWorld(path.join(base, 'source'), { dataVersion: 5023, spawn: [1024, 64, 1024], ...options }), world = inspectWorld(root);
  const dim = world.dimensions.find(d => d.id === 'minecraft:overworld').key;
  return { base, root, world, dim, c: (x = 0, z = 0, dimension = dim) => ({ x, z, dimension }),
    relative: (store = 'region', name = 'r.0.0.mca') => path.join('dimensions/minecraft/overworld', store, name) };
}
function review(f, selected = [f.c()], protection = [], bufferChunks = 0) {
  f.world = inspectWorld(f.root);
  return createRegenerationReview(f.world, selected, protection, { bufferChunks });
}
function assertManifest(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
  const actual = inventory(path.join(directory, 'world'));
  assert.deepEqual(actual.files.map(f => f.path).sort(), manifest.files.map(f => f.path).sort());
  for (const file of manifest.files) assert.equal(hashFile(path.join(directory, 'world', file.path)), file.sha256);
}

test('export deletes coordinated slots only in its own copy and preserves original, backup and every other byte', t => {
  const f = setup(t); fs.mkdirSync(path.join(f.root, 'empty-directory'));
  const plan = review(f, [f.c(), f.c(1)], [f.c(1)]), before = hashTree(f.root);
  assert.equal(plan.copyExport.eligible, true); assert.equal(plan.executable, false);
  const result = createRegeneratedCopy(f.world, plan, f.base, acknowledgements);
  assert.equal(result.removedChunks, 1); assert.deepEqual(hashTree(f.root), before);
  for (const file of before) assert.equal(hashFile(path.join(result.backup, file.path)), file.sha256);
  const changed = new Set(['region', 'entities', 'poi'].map(s => f.relative(s)));
  for (const file of before) {
    const old = fs.readFileSync(path.join(f.root, file.path)), actual = fs.readFileSync(path.join(result.world, file.path));
    if (changed.has(file.path)) { old.writeUInt32BE(0, 0); old.writeUInt32BE(0, 4096); }
    assert.deepEqual(actual, old, file.path);
  }
  assert.equal(inspectWorld(result.world).totals.chunks, f.world.totals.chunks - 1);
  for (const label of ['backup', 'result']) assertManifest(path.join(result.directory, label));
  const validation = JSON.parse(fs.readFileSync(result.report));
  assert.equal(validation.gameLoadTested, false); assert.equal(validation.sourceAndBackupVerified, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.directory, 'operation.json'))).status, 'validated-test-copy');
  assert.ok(!inventory(result.world).files.some(f => f.path.includes('worldrenew')));
});

test('negative coordinates, cross-region selections and diagonal buffers preserve protected slots and other dimensions', t => {
  const f = setup(t); writeRegion(path.join(f.root, f.relative('region', 'r.-2.0.mca')), [{ x: -33, z: 0 }, { x: -34, z: 0 }]);
  writeRegion(path.join(f.root, f.relative('region', 'r.-1.0.mca')), [{ x: -32, z: 0 }]);
  const plan = review(f, [f.c(-34), f.c(-33), f.c(-32), f.c(1)], [f.c(-34)], 1);
  assert.equal(plan.excludedProtected.length, 1); assert.equal(plan.excludedBuffer.length, 1);
  const result = createRegeneratedCopy(f.world, plan, f.base, acknowledgements);
  assert.equal(result.removedChunks, 2);
  assert.equal(hashFile(path.join(result.world, f.relative('region', 'r.-2.0.mca'))), hashFile(path.join(f.root, f.relative('region', 'r.-2.0.mca'))));
  assert.equal(inspectRegion(result.world, f.relative('region', 'r.-1.0.mca')).present, 0);
  assert.equal(inspectRegion(result.world, 'dimensions/minecraft/the_nether/region/r.0.0.mca').present, 1);
});

for (const compression of [1, 2, 3]) test(`verified empty external compression ${compression} removes matching sidecars and preserves unrelated sidecars`, t => {
  const f = setup(t);
  for (const store of ['region', 'entities', 'poi']) {
    const file = path.join(f.root, f.relative(store));
    const bytes = fs.readFileSync(file); bytes.writeUInt32BE(1, 8192); bytes[8196] = 128 | compression; fs.writeFileSync(file, bytes);
    const raw = nbt(emptyRecordTags(0, 0, store));
    fs.writeFileSync(path.join(f.root, f.relative(store, 'c.0.0.mcc')), compression === 1 ? gzipSync(raw) : compression === 2 ? deflateSync(raw) : raw);
    fs.writeFileSync(path.join(f.root, f.relative(store, 'c.100.100.mcc')), 'unrelated');
  }
  const plan = review(f), before = hashTree(f.root);
  const result = createRegeneratedCopy(f.world, plan, f.base, acknowledgements);
  for (const store of ['region', 'entities', 'poi']) {
    assert.equal(fs.existsSync(path.join(result.world, f.relative(store, 'c.0.0.mcc'))), false);
    assert.equal(fs.readFileSync(path.join(result.world, f.relative(store, 'c.100.100.mcc')), 'utf8'), 'unrelated');
  }
  assert.deepEqual(hashTree(f.root), before); assertManifest(path.join(result.directory, 'result'));
});

test('missing and zero-byte auxiliary stores stay absent or exactly empty', t => {
  const f = setup(t); fs.unlinkSync(path.join(f.root, f.relative('entities'))); fs.writeFileSync(path.join(f.root, f.relative('poi')), '');
  const plan = review(f), result = createRegeneratedCopy(f.world, plan, f.base, acknowledgements);
  assert.equal(fs.existsSync(path.join(result.world, f.relative('entities'))), false);
  assert.equal(fs.statSync(path.join(result.world, f.relative('poi'))).size, 0);
});

test('export rejects open-world requests, missing acknowledgement, forged digests and destinations in saves', t => {
  const f = setup(t), plan = review(f);
  assert.throws(() => createRegeneratedCopy(f.world, plan, f.base), { code: 'WORLD_OPEN' });
  assert.throws(() => createRegeneratedCopy(f.world, plan, f.base, { confirmedClosed: true }), { code: 'EXPORT_ACK' });
  assert.throws(() => createRegeneratedCopy(f.world, { ...plan, reviewDigest: 'forged' }, f.base, acknowledgements), { code: 'REVIEW_STALE' });
  for (const root of [f.root, makeWorld(path.join(f.base, 'other'))]) {
    const alias = path.join(f.base, 'alias'); fs.symlinkSync(root, alias);
    assert.throws(() => createRegeneratedCopy(f.world, plan, alias, acknowledgements), { code: 'ARCHIVE_IN_WORLD' }); fs.unlinkSync(alias);
  }
  assert.ok(!fs.readdirSync(f.base).some(n => n.includes('WorldRenew-')));
});

test('unsupported versions, dimensions, malformed regions, or all-protected plans cannot export', t => {
  for (const version of ['26.2', '26.4', '27.1', '26.3-pre1', '1.21.4']) {
    const f = setup(t, { version }), plan = review(f);
    assert.equal(plan.copyExport.eligible, false);
    assert.throws(() => createRegeneratedCopy(f.world, plan, f.base, acknowledgements), { code: 'EXPORT_BLOCKED' });
  }
  const f = setup(t), nether = f.world.dimensions.find(d => d.id === 'minecraft:the_nether').key;
  for (const plan of [review(f, [f.c(0, 0, nether)]), review(f, [f.c()], [f.c()])]) {
    assert.throws(() => createRegeneratedCopy(f.world, plan, f.base, acknowledgements), { code: 'EXPORT_BLOCKED' });
  }
  const bytes = fs.readFileSync(path.join(f.root, f.relative())); bytes.writeUInt32BE(bytes.readUInt32BE(0), 4); fs.writeFileSync(path.join(f.root, f.relative()), bytes);
  const malformed = review(f);
  assert.throws(() => createRegeneratedCopy(f.world, malformed, f.base, acknowledgements), { code: 'EXPORT_BLOCKED' });
});

test('stale reviewed content is rejected even when it is an absent or same-size sidecar', t => {
  const f = setup(t), plan = review(f);
  fs.writeFileSync(path.join(f.root, f.relative('poi', 'c.0.0.mcc')), 'orphan');
  assert.throws(() => createRegeneratedCopy(f.world, plan, f.base, acknowledgements), { code: 'REVIEW_STALE' });
  assert.ok(!fs.readdirSync(f.base).some(n => n.includes('WorldRenew-')));
});

test('post-write corruption discards the result and retains a verified backup with failed journal', t => {
  const f = setup(t), plan = review(f), before = hashTree(f.root); let failedStage;
  assert.throws(() => createRegeneratedCopy(f.world, plan, f.base, acknowledgements, p => {
    if (p.phase === 'Validating regeneration copy') {
      failedStage = path.dirname(path.dirname(p.file));
      // Corrupt a preserved payload while retaining a valid envelope: structural checks alone miss it.
      const file = path.join(p.file, f.relative()), b = fs.readFileSync(file); b[12300] ^= 1; fs.writeFileSync(file, b);
    }
  }), { code: 'EXPORT_HASH' });
  assert.deepEqual(hashTree(f.root), before);
  assert.ok(!fs.existsSync(path.join(failedStage, 'result'))); assertManifest(path.join(failedStage, 'backup'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(failedStage, 'operation.json'))).status, 'failed-working-copy-discarded');
  assert.ok(!fs.readdirSync(f.base).some(n => n.startsWith('WorldRenew-')));
});

test('late source change aborts publication without overwriting that change or the backup', t => {
  const f = setup(t), plan = review(f); let stage;
  assert.throws(() => createRegeneratedCopy(f.world, plan, f.base, acknowledgements, p => {
    if (p.phase === 'Validating regeneration copy') {
      stage = path.dirname(path.dirname(p.file)); fs.writeFileSync(path.join(f.root, 'concurrent-change'), 'external writer');
    }
  }), { code: 'EXPORT_FILES' });
  assert.equal(fs.readFileSync(path.join(f.root, 'concurrent-change'), 'utf8'), 'external writer');
  assert.ok(!fs.existsSync(path.join(stage, 'result'))); assertManifest(path.join(stage, 'backup'));
});

test('symlinks anywhere in the world and insufficient two-copy capacity fail before export', t => {
  const f = setup(t), plan = review(f);
  fs.symlinkSync(path.join(f.root, 'level.dat'), path.join(f.root, 'unsafe'));
  assert.throws(() => createRegeneratedCopy(f.world, plan, f.base, acknowledgements), { code: 'COPY_LINK' });
  fs.unlinkSync(path.join(f.root, 'unsafe'));
  t.mock.method(fs, 'statfsSync', () => ({ bavail: 0, bsize: 4096 }));
  assert.throws(() => createRegeneratedCopy(f.world, plan, f.base, acknowledgements), { code: 'COPY_SPACE' });
  assert.ok(!fs.readdirSync(f.base).some(n => n.includes('WorldRenew-')));
});

test('completed backup survives a failure to move it into its transaction label', t => {
  const f = setup(t), plan = review(f), rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.basename(to) === 'backup') throw new Error('injected backup label failure');
    return rename(from, to);
  });
  assert.throws(() => createRegeneratedCopy(f.world, plan, f.base, acknowledgements), /Verified backup retained/);
  const stage = path.join(f.base, fs.readdirSync(f.base).find(n => n.endsWith('.partial')));
  const journal = JSON.parse(fs.readFileSync(path.join(stage, 'operation.json')));
  assert.equal(journal.status, 'failed-working-copy-discarded');
  assertManifest(path.dirname(path.join(stage, journal.backup)));
});
