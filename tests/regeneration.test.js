import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeWorld, writeRegion } from './fixtures.js';
import { inspectWorld } from '../engine/world.js';
import { createRegenerationReview, saveRegenerationReview } from '../engine/regeneration.js';
import { createVerifiedCopy, hashFile, executeDestructiveOperation } from '../engine/safety.js';

function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'worldrenew-review-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = makeWorld(path.join(base, 'world'));
  const world = inspectWorld(root), dimension = world.dimensions.find(d => d.id === 'minecraft:overworld').key;
  return { base, root, world, dimension, select: (x = 0, z = 0, d = dimension) => ({ dimension: d, x, z }), store: (s = 'region', name = 'r.0.0.mca') => path.join(root, 'dimensions/minecraft/overworld', s, name) };
}
function tree(root) {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => {
    const file = path.join(e.parentPath, e.name), stat = fs.statSync(file);
    return { file, bytes: stat.size, mtimeMs: stat.mtimeMs, sha256: hashFile(file) };
  });
}
function external(f, store = 'region') {
  const file = f.store(store), bytes = fs.readFileSync(file);
  bytes.writeUInt32BE(1, 8192); bytes[8196] = 130; fs.writeFileSync(file, bytes);
  const sidecar = f.store(store, 'c.0.0.mcc'); fs.writeFileSync(sidecar, Buffer.from([1, 2, 3, 4])); return sidecar;
}

test('detailed dry-run inventories coordinated records and explicit absences without modifying any source file', t => {
  const f = setup(t), before = tree(f.root);
  const review = createRegenerationReview(f.world, [f.select(), f.select(1), f.select()], [], { bufferChunks: 0 });
  assert.equal(review.executable, false); assert.equal(review.status, 'review-only');
  assert.deepEqual(review.counts.records, { region: 2, entities: 1, poi: 1, external: 0, absent: 2, invalid: 0 });
  assert.equal(review.counts.affectedRegionFiles, 3); assert.equal(review.records.length, 6);
  assert.equal(review.selection.length, 2); assert.equal(review.backup.verified, false);
  assert.ok(review.requiredGates.every(g => g.satisfied === false));
  assert.ok(review.inputFiles.some(f => f.path.endsWith('c.1.0.mcc') && !f.present));
  for (const file of review.inputFiles.filter(f => f.present)) assert.equal(file.sha256, hashFile(path.join(f.root, file.path)));
  const result = saveRegenerationReview(path.join(f.base, 'reports'), f.world, review);
  const saved = JSON.parse(fs.readFileSync(result.file));
  assert.equal(saved.reviewDigest, review.reviewDigest); assert.equal(saved.executable, false);
  assert.deepEqual(tree(f.root), before);
  assert.throws(() => executeDestructiveOperation({ review: saved, backup: { verified: true } }), { code: 'WRITES_DISABLED' });
});

test('buffers include diagonal negative-coordinate neighbors but never cross dimension identity', t => {
  const f = setup(t), nether = f.world.dimensions.find(d => d.id === 'minecraft:the_nether').key;
  const selected = [f.select(), f.select(1), f.select(-1, -1), f.select(0, 0, nether)];
  const review = createRegenerationReview(f.world, selected, [f.select()], { bufferChunks: 1 });
  assert.equal(review.excludedProtected.length, 1); assert.equal(review.excludedBuffer.length, 2);
  assert.deepEqual(review.candidates, [f.select(0, 0, nether)]);
  assert.ok(review.warnings.some(w => w.includes('portal-network')));
  const zero = createRegenerationReview(f.world, selected, [f.select()], { bufferChunks: 0 });
  assert.equal(zero.candidates.length, 3);
});

test('all-protected selections have no removal records and cannot look executable', t => {
  const f = setup(t), r = createRegenerationReview(f.world, [f.select()], [f.select()]);
  assert.equal(r.status, 'blocked'); assert.equal(r.records.length, 0); assert.equal(r.candidates.length, 0);
  assert.ok(r.blockers.some(b => b.includes('No candidate')));
});

test('malformed selected terrain stays visible with structural blockers', t => {
  const f = setup(t), bytes = fs.readFileSync(f.store()); bytes[8196] = 99; fs.writeFileSync(f.store(), bytes);
  const r = createRegenerationReview(inspectWorld(f.root), [f.select()], [], { bufferChunks: 0 });
  assert.equal(r.status, 'blocked'); assert.equal(r.records[0].status, 'invalid');
  assert.equal(r.counts.records.invalid, 1); assert.ok(r.blockers.some(b => b.includes('structural')));
});

test('unreadable auxiliary regions are blocked rather than silently represented as absent', t => {
  const f = setup(t); fs.writeFileSync(f.store('entities'), Buffer.alloc(7));
  const r = createRegenerationReview(inspectWorld(f.root), [f.select()], []);
  assert.equal(r.status, 'blocked'); assert.equal(r.records.find(r => r.store === 'entities').status, 'unreadable');
});

test('zero-byte auxiliary stores are explicit empty records in the dry-run', t => {
  const f = setup(t); fs.writeFileSync(f.store('entities'), Buffer.alloc(0)); fs.writeFileSync(f.store('poi'), Buffer.alloc(0));
  const r = createRegenerationReview(inspectWorld(f.root), [f.select()], []);
  assert.equal(r.status, 'review-only'); assert.equal(r.counts.records.absent, 2);
});

test('external sidecars in all three stores are fingerprinted and source bytes remain unchanged', t => {
  const f = setup(t); for (const store of ['region', 'entities', 'poi']) external(f, store);
  const before = tree(f.root), r = createRegenerationReview(inspectWorld(f.root), [f.select()], []);
  assert.equal(r.counts.records.external, 3); assert.ok(r.records.every(record => record.sidecar));
  assert.equal(r.status, 'review-only'); assert.deepEqual(tree(f.root), before);
  assert.ok(r.warnings.some(w => w.includes('Header and file checks only')));
});

test('orphan, missing, and unsafe external sidecars block review', t => {
  const f = setup(t), sidecar = external(f); fs.unlinkSync(sidecar);
  let r = createRegenerationReview(inspectWorld(f.root), [f.select()], []);
  assert.equal(r.status, 'blocked'); assert.ok(r.blockers.some(b => b.includes('missing')));
  writeRegion(f.store(), [{ x: 0, z: 0 }, { x: 1, z: 0 }]); fs.writeFileSync(sidecar, 'orphan');
  r = createRegenerationReview(inspectWorld(f.root), [f.select()], []);
  assert.ok(r.blockers.some(b => b.includes('ownership')));
  fs.unlinkSync(sidecar); fs.symlinkSync(path.join(f.root, 'level.dat'), sidecar);
  r = createRegenerationReview(inspectWorld(f.root), [f.select()], []);
  assert.equal(r.status, 'blocked'); assert.ok(r.blockers.some(b => b.includes('Symbolic links')));
});

test('changes since displayed inventory require a refresh, including auxiliary changes and new regions', t => {
  for (const store of ['region', 'entities', 'poi']) {
    const f = setup(t), bytes = fs.readFileSync(f.store(store)); bytes[9000] ^= 1; fs.writeFileSync(f.store(store), bytes);
    assert.throws(() => createRegenerationReview(f.world, [f.select()], []), { code: 'REVIEW_STALE' });
  }
  const f = setup(t); writeRegion(f.store('region', 'r.2.2.mca'), [{ x: 64, z: 64 }]);
  assert.throws(() => createRegenerationReview(f.world, [f.select()], []), { code: 'REVIEW_STALE' });
});

test('source changes during the dry-run are rejected before publishing a review', t => {
  const f = setup(t); let changed = false;
  assert.throws(() => createRegenerationReview(f.world, [f.select()], [], {}, p => {
    if (p.phase === 'Verifying review inputs' && !changed) { changed = true; fs.appendFileSync(f.store('entities'), Buffer.alloc(4096)); }
  }), { code: 'REVIEW_CHANGED' });
});

test('same-size external payload change invalidates report saving even when region inventory is unchanged', t => {
  const f = setup(t), sidecar = external(f), world = inspectWorld(f.root);
  const r = createRegenerationReview(world, [f.select()], []);
  fs.writeFileSync(sidecar, Buffer.from([4, 3, 2, 1]));
  assert.equal(inspectWorld(f.root).inventoryFingerprint, world.inventoryFingerprint);
  assert.throws(() => saveRegenerationReview(path.join(f.base, 'reports'), world, r), { code: 'REVIEW_STALE' });
  assert.equal(fs.existsSync(path.join(f.base, 'reports')), false);
});

test('a newly appearing sidecar invalidates previously absent review inputs', t => {
  const f = setup(t), r = createRegenerationReview(f.world, [f.select()], []);
  fs.writeFileSync(f.store('poi', 'c.0.0.mcc'), 'new');
  assert.throws(() => saveRegenerationReview(path.join(f.base, 'reports'), f.world, r), { code: 'REVIEW_STALE' });
});

test('report output cannot be saved inside source, another save, or their symlink aliases', t => {
  const f = setup(t), r = createRegenerationReview(f.world, [f.select()], []);
  assert.throws(() => saveRegenerationReview(path.join(f.root, 'reports'), f.world, r), { code: 'PROJECT_IN_WORLD' });
  const other = makeWorld(path.join(f.base, 'other'));
  assert.throws(() => saveRegenerationReview(path.join(other, 'reports'), f.world, r), { code: 'REVIEW_IN_WORLD' });
  const alias = path.join(f.base, 'alias'); fs.symlinkSync(other, alias);
  assert.throws(() => saveRegenerationReview(path.join(alias, 'reports'), f.world, r), { code: 'REVIEW_IN_WORLD' });
});

test('bad generation metadata blocks both review and the verified-copy workflow', t => {
  const f = setup(t); fs.writeFileSync(path.join(f.root, 'data/minecraft/world_gen_settings.dat'), 'broken');
  const world = inspectWorld(f.root), r = createRegenerationReview(world, [f.select()], []);
  assert.ok(world.validationErrors.length); assert.ok(r.blockers.some(b => b.includes('World-generation metadata')));
  assert.throws(() => createVerifiedCopy(f.root, f.base, { confirmedClosed: true }), { code: 'COPY_VALIDATION' });
  assert.equal(fs.readdirSync(f.base).some(n => n.includes('WorldRenew-')), false);
});

test('duplicate layouts block review and End plans require global-metadata review', t => {
  const f = setup(t); writeRegion(path.join(f.root, 'region/r.0.0.mca'));
  const world = inspectWorld(f.root), end = world.dimensions.find(d => d.id === 'minecraft:the_end').key;
  const r = createRegenerationReview(world, [f.select(), f.select(0, 0, end)], []);
  assert.ok(r.blockers.some(b => b.includes('Ambiguous storage')));
  assert.ok(r.warnings.some(w => w.includes('dragon-fight')));
});

test('review limits and malformed selections fail before expensive planning', t => {
  const f = setup(t);
  for (const bufferChunks of [-1, 9, 0.5, '1']) assert.throws(() => createRegenerationReview(f.world, [f.select()], [], { bufferChunks }), { code: 'REVIEW_BUFFER' });
  for (const selection of [[], Array(10001).fill(f.select()), null]) assert.throws(() => createRegenerationReview(f.world, selection, []), { code: 'REVIEW_LIMIT' });
  assert.throws(() => createRegenerationReview(f.world, [f.select(999)], []), { code: 'PROJECT_CHUNK' });
  assert.throws(() => createRegenerationReview(f.world, [f.select()], [f.select(999)]), { code: 'PROJECT_CHUNK' });
});
