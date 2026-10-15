import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFixture, regionPath, writeRecords, terrainTags } from './fixtures.mjs';
import { treeHashes } from './oracle.mjs';
import { previewRegionImport, inspectSeam } from './research.mjs';
import { state } from '../tests/transfer-fixtures.js';

function setup(t, opts = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'worldrenew-research-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { source: createFixture(path.join(base, 'source')), destination: createFixture(path.join(base, 'destination'), opts) };
}
const selected = { chunks: [{ x: 0, z: 0 }] };
const seam = { pairs: [{ source: { x: 8, z: 8 }, destination: { x: 8, z: 8 } }], minY: 64, maxY: 79 };

test('occupied terrain, entities and POI conflict even if payloads match; selected entity UUID collisions are explicit', t => {
  const f = setup(t), before = [treeHashes(f.source), treeHashes(f.destination)];
  const report = previewRegionImport(f.source, f.destination, { ...selected, protection: [{ dimension: 'minecraft:overworld', x: 0, z: 0 }] });
  assert.equal(report.executable, false); assert.equal(report.uuidCollisions, 1);
  assert.deepEqual(report.mappings[0].conflicts, ['PROTECTED_DESTINATION', 'DESTINATION_REGION_OCCUPIED', 'DESTINATION_ENTITIES_OCCUPIED', 'DESTINATION_POI_OCCUPIED']);
  assert.equal(report.mappings[0].records.region.payloadEqual, true);
  assert.deepEqual([treeHashes(f.source), treeHashes(f.destination)], before);
});
test('negative and cross-region offsets map by floor division without mutating chunk coordinates', t => {
  const f = setup(t), before = treeHashes(f.source);
  const report = previewRegionImport(f.source, f.destination, { chunks: [{ x: 31, z: 0 }, { x: 32, z: 0 }], offset: { x: -64, z: -1 } });
  assert.deepEqual(report.mappings.map(m => m.target), [{ x: -33, z: -1 }, { x: -32, z: -1 }]);
  assert.deepEqual(report.mappings.map(m => m.region), [{ x: -2, z: -1 }, { x: -1, z: -1 }]);
  assert.ok(report.mappings.every(m => m.conflicts.length === 0));
  assert.equal(report.executable, false); assert.ok(report.unresolved.some(s => s.includes('relocation')));
  assert.deepEqual(treeHashes(f.source), before);
});
test('destination entity and POI records remain conflicts when terrain is absent', t => {
  const f = setup(t), file = path.join(f.destination, regionPath('overworld', 'region'));
  fs.unlinkSync(file); // Only our newly generated fixture is modified.
  const report = previewRegionImport(f.source, f.destination, selected);
  assert.equal(report.mappings[0].records.region.destinationPresent, false);
  assert.ok(report.mappings[0].conflicts.includes('DESTINATION_ENTITIES_OCCUPIED'));
  assert.ok(report.mappings[0].conflicts.includes('DESTINATION_POI_OCCUPIED'));
});
test('DataVersion and seed mismatches are reported; missing source is never empty importable terrain', t => {
  const f = setup(t, { dataVersion: 4903, seed: 67890n });
  const report = previewRegionImport(f.source, f.destination, { chunks: [{ x: 2, z: 0 }] });
  assert.ok(report.blockers.includes('VERSION_MISMATCH')); assert.ok(report.blockers.includes('SEED_MISMATCH'));
  assert.ok(report.mappings[0].conflicts.includes('SOURCE_TERRAIN_MISSING'));
});
test('malformed compressed source remains unreadable rather than silently becoming air', t => {
  const f = setup(t), file = path.join(f.source, regionPath('overworld', 'region')), bytes = fs.readFileSync(file);
  bytes[8197] ^= 0xff; fs.writeFileSync(file, bytes);
  const report = previewRegionImport(f.source, f.destination, selected);
  assert.ok(report.mappings[0].conflicts.includes('UNREADABLE_RECORD'));
  assert.equal(report.executable, false);
});
test('same X/Z in another dimension does not inherit unrelated protection', t => {
  const f = setup(t), report = previewRegionImport(f.source, f.destination, { ...selected, dimensionId: 'minecraft:the_nether', protection: [{ dimension: 'minecraft:overworld', x: 0, z: 0 }] });
  assert.ok(!report.mappings[0].conflicts.includes('PROTECTED_DESTINATION'));
  assert.ok(report.unresolved.some(s => s.includes('portal')));
});
test('duplicate selections and fractional offsets are rejected before research', t => {
  const f = setup(t);
  assert.throws(() => previewRegionImport(f.source, f.destination, { chunks: [{ x: 0, z: 0 }, { x: 0, z: 0 }] }));
  assert.throws(() => previewRegionImport(f.source, f.destination, { ...selected, offset: { x: 0.5, z: 0 } }));
});
test('equal sampled terrain never proves seamlessness; protection remains a hard constraint', t => {
  const f = setup(t), before = [treeHashes(f.source), treeHashes(f.destination)];
  const report = inspectSeam(f.source, f.destination, { ...seam, protection: [{ dimension: 'minecraft:overworld', x: 0, z: 0 }] });
  assert.equal(report.metrics.maxWindowTopDelta, 0); assert.equal(report.metrics.occupancyMismatch, 0);
  assert.equal(report.metrics.protectedSamples, 16); assert.equal(report.seamlessnessProven, false); assert.equal(report.blended, false);
  assert.deepEqual([treeHashes(f.source), treeHashes(f.destination)], before);
});
test('matching top heights can hide cave discontinuities', t => {
  const f = setup(t);
  for (const [root, cave] of [[f.source, true], [f.destination, false]]) {
    const file = path.join(root, regionPath('overworld', 'region')); fs.unlinkSync(file);
    writeRecords(file, [{ x: 0, z: 0, tags: terrainTags(0, 0, (_x, y) => state(cave && y === 68 ? 'air' : y <= 70 ? 'stone' : 'air')) }]);
  }
  const report = inspectSeam(f.source, f.destination, seam);
  assert.equal(report.metrics.maxWindowTopDelta, 0); assert.equal(report.metrics.occupancyMismatch, 1);
  assert.equal(report.seamlessnessProven, false);
});
test('missing columns remain unknown and do not acquire fabricated heights', t => {
  const f = setup(t), report = inspectSeam(f.source, f.destination, { ...seam, pairs: [{ source: { x: 8, z: 8 }, destination: { x: 40, z: 8 } }] });
  assert.equal(report.metrics.unknown, 16); assert.equal(report.metrics.maxWindowTopDelta, null);
});
test('fluid and bedrock contacts are surfaced without smoothing roof access away', t => {
  const f = setup(t), file = path.join(f.destination, regionPath('the_nether', 'region')); fs.unlinkSync(file);
  writeRecords(file, [{ x: 0, z: 0, tags: terrainTags(0, 0, () => state('water'), { ys: [7] }) }]);
  const report = inspectSeam(f.source, f.destination, { dimensionId: 'minecraft:the_nether', pairs: [{ source: { x: 4, z: 3 }, destination: { x: 4, z: 3 } }], minY: 127, maxY: 127 });
  assert.equal(report.metrics.fluidContacts, 1); assert.equal(report.metrics.bedrockContacts, 1); assert.equal(report.executable, false);
});
test('excessive seam sampling is rejected before reading worlds', () => {
  assert.throws(() => inspectSeam('/does-not-exist', '/does-not-exist', { ...seam, pairs: Array(65).fill(seam.pairs[0]) }), /sample/);
});
