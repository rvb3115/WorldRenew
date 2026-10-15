import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { preservationWorld } from '../tests/preservation-fixtures.js';
import { inspectWorld } from '../engine/world.js';
import { inventory, hashFile, createVerifiedCopy } from '../engine/safety.js';
import { createRegenerationReview } from '../engine/regeneration.js';
import { createRegeneratedCopy } from '../engine/regeneration-export.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.mkdirSync(path.join(project, 'work'), { recursive: true });
const work = fs.mkdtempSync(path.join(project, 'work/preservation-demo-'));
const index = process.argv.indexOf('--world'), external = index >= 0;
if (external && (!process.argv.includes('--closed') || !process.argv.includes('--confirm-test-export') || !process.argv[index + 1])) {
  throw Error('Real-save tests require --world PATH --closed --confirm-test-export. Only owned copies are edited. Close Minecraft first.');
}
const source = external ? path.resolve(process.argv[index + 1]) : preservationWorld(path.join(work, 'synthetic-source'));
const tree = root => inventory(root).files.map(f => ({ path: f.path, sha256: hashFile(path.join(root, f.path)) }));
const beforeInventory = inventory(source), before = tree(source);
const input = createVerifiedCopy(source, work, { confirmedClosed: true }), world = inspectWorld(input.world);
const dim = world.dimensions.find(d => d.id === 'minecraft:overworld');
const chunks = dim.regions.flatMap(r => r.chunks).filter(c => c.valid).map(c => ({ dimension: dim.key, x: c.x, z: c.z }));
const selected = external ? [chunks[0]] : chunks.filter(c => c.z === 0 && [0, 4].includes(c.x));
const protection = external ? chunks.filter(c => Math.abs(c.x-selected[0].x) > 2 || Math.abs(c.z-selected[0].z) > 2).slice(0, 1) : [{ dimension: dim.key, x: 0, z: 0 }];
const review = createRegenerationReview(world, selected, protection, { bufferChunks: 1 });
fs.writeFileSync(path.join(work, 'preview.json'), JSON.stringify(review, null, 2));
assert.equal(review.copyExport.eligible, true, review.copyExport.blockers.join(' '));
assert.equal(review.candidates.length, 1); assert.equal(protection.length, 1);
const output = createRegeneratedCopy(world, review, work, { confirmedClosed: true, confirmedExperimental: true });
const records = new Map();
for (const record of review.records.filter(r => r.status === 'present')) {
  if (!records.has(record.region)) records.set(record.region, []);
  records.get(record.region).push(record);
}
const sidecars = new Set(review.records.filter(r => r.external).map(r => r.sidecar));
for (const file of before) {
  if (sidecars.has(file.path)) { assert.equal(fs.existsSync(path.join(output.world, file.path)), false); continue; }
  const expected = fs.readFileSync(path.join(input.world, file.path));
  for (const r of records.get(file.path) ?? []) {
    const slot = ((r.x % 32 + 32) % 32) + ((r.z % 32 + 32) % 32) * 32;
    expected.fill(0, slot * 4, slot * 4 + 4); expected.fill(0, 4096 + slot * 4, 4100 + slot * 4);
  }
  assert.deepEqual(fs.readFileSync(path.join(output.world, file.path)), expected, file.path);
}
assert.deepEqual(tree(output.backup), before); assert.deepEqual(tree(input.world), before);
const restored = createVerifiedCopy(output.backup, work, { confirmedClosed: true });
assert.deepEqual(tree(restored.world), before); assert.deepEqual(tree(source), before); assert.deepEqual(inventory(source), beforeInventory);
const result = {
  runAt: new Date().toISOString(), fixture: external ? 'real-save disposable-copy test' : 'synthetic format fixture; NOT playable',
  version: world.metadata.version, dataVersion: world.metadata.dataVersion, sourceFiles: before.length,
  sourceBytes: beforeInventory.files.reduce((sum, f) => sum + f.bytes, 0), sourceUnchanged: true, inputCopyUnchanged: true,
  backupByteIdentical: true, restorationByteIdentical: true, protectedChunks: protection, removedChunks: review.candidates,
  untouchedRegionBytesVerified: true, playerRecords: review.playerSafety.players.length,
  playerFiles: before.filter(f => /^(players|playerdata|stats|advancements)\//.test(f.path)).map(f => ({ ...f, resultSha256: hashFile(path.join(output.world, f.path)) })),
  gameLoadTested: false, upgradeTested: false, farmMechanicsTested: false, seamlessTerrainTested: false,
  output: output.world, backup: output.backup, restored: restored.world
};
fs.writeFileSync(path.join(work, 'evidence.json'), JSON.stringify(result, null, 2));
console.log(`PASS: original, backup, protected bytes, player files and restored copy verified.\nEvidence: ${path.join(work, 'evidence.json')}`);
