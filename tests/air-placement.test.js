import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBlockWorld, state } from './transfer-fixtures.js';
import { placementWorld } from './placement-fixtures.js';
import { inspectWorld } from '../engine/world.js';
import { captureBuildArchive, saveBuildFile, readBuildFile, sha } from '../engine/build-archive.js';
import { previewBuildFile, createPlacedCopy } from '../engine/copy-placement.js';
import { previewCapturedTransfer, DIFFERENCE } from '../engine/transfers.js';
import { captureVolume } from '../engine/volumes.js';
import { isAir, stateKey } from '../engine/chunks.js';
const bounds = { minX: 1, maxX: 5, minY: 1, maxY: 5, minZ: 1, maxZ: 5 }, anchor = { x: 20, y: 2, z: 20 };
const dimension = w => w.dimensions.find(d => d.id === 'minecraft:overworld').key;
const hashes = root => Object.fromEntries(fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(f => f.isFile()).map(f => { const file = path.join(f.parentPath, f.name); return [path.relative(root, file), sha(fs.readFileSync(file))]; }));
function fixture(t, structureVoid = false) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'worldrenew-air-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = makeBlockWorld(path.join(base, 'source'), { version: '26.2', dataVersion: 4903, block: (x, y, z) => {
    if (structureVoid && x === 3 && y === 3 && z === 3) return state('structure_void');
    if (x > 1 && x < 5 && y > 1 && y < 5 && z > 1 && z < 5) return state(['air','cave_air','void_air'][x - 2]);
    return state('oak_planks');
  } });
  const world = inspectWorld(root), file = path.join(base, 'room.wrbuild'); saveBuildFile(file, captureBuildArchive(world, dimension(world), bounds));
  const destination = inspectWorld(placementWorld(path.join(base, 'destination')));
  return { base, root, world, file, destination };
}
test('include air carves an enclosed room and preserves exact air/cave_air/void_air states', t => {
  const f = fixture(t), before = hashes(f.destination.root), source = hashes(f.root), plan = previewBuildFile(f.file, f.destination, dimension(f.destination), anchor);
  assert.equal(plan.copyEligible, true); assert.equal(plan.counts.carved, 27); assert.equal(plan.effects.changedBlocks, 125);
  assert.deepEqual(plan.effects.sourceAir, { air: 9, caveAir: 9, voidAir: 9, structureVoid: 0, unknown: 0 });
  const result = createPlacedCopy(f.file, f.destination, dimension(f.destination), anchor, f.base, { confirmedClosed: true, reviewDigest: plan.reviewDigest, airMode: 'include' });
  const world = inspectWorld(result.world), volume = captureVolume(world, dimension(world), plan.destination.bounds);
  assert.equal(volume.stats.air, 27);
  for (let i = 0; i < volume.voxels.length; i++) assert.equal(stateKey(volume.palette[volume.voxels[i]]), stateKey(plan.source.palette[plan.source.voxels[i]]));
  assert.deepEqual(hashes(f.destination.root), before); assert.deepEqual(hashes(result.backup), before); assert.deepEqual(hashes(f.root), source);
});
test('skip air preserves target blocks, changes only room walls, and mode is bound into review digest', t => {
  const f = fixture(t), include = previewBuildFile(f.file, f.destination, dimension(f.destination), anchor);
  const skip = previewBuildFile(f.file, f.destination, dimension(f.destination), anchor, () => {}, [], { airMode: 'skip' });
  assert.equal(skip.copyEligible, true); assert.equal(skip.counts.skippedAir, 27); assert.equal(skip.counts.carved, 0); assert.equal(skip.effects.changedBlocks, 98);
  assert.notEqual(skip.reviewDigest, include.reviewDigest); assert.ok(skip.differences.includes(DIFFERENCE.skippedAir));
  assert.throws(() => createPlacedCopy(f.file, f.destination, dimension(f.destination), anchor, f.base, { confirmedClosed: true, reviewDigest: include.reviewDigest, airMode: 'skip' }), { code: 'PLACEMENT_STALE' });
  const result = createPlacedCopy(f.file, f.destination, dimension(f.destination), anchor, f.base, { confirmedClosed: true, reviewDigest: skip.reviewDigest, airMode: 'skip' });
  const world = inspectWorld(result.world), volume = captureVolume(world, dimension(world), skip.destination.bounds);
  assert.equal(volume.stats.air, 0);
  for (let i = 0; i < volume.voxels.length; i++) {
    const source = skip.source.palette[skip.source.voxels[i]], expected = isAir(source) ? skip.destination.palette[skip.destination.voxels[i]] : source;
    assert.equal(stateKey(volume.palette[volume.voxels[i]]), stateKey(expected));
  }
  assert.equal(JSON.parse(fs.readFileSync(result.report)).airMode, 'skip');
  assert.equal(result.effects.skippedAir, 27);
});
test('unknown data is never skipped as air; structure_void is retained and blocks unsupported placement', t => {
  const f = fixture(t), volume = readBuildFile(f.file).volume; volume.voxels[0] = 0; volume.complete = false;
  const preview = previewCapturedTransfer(volume, 'minecraft:overworld', f.destination, dimension(f.destination), anchor, () => {}, { airMode: 'skip' });
  assert.equal(preview.counts.unknown, 1); assert.equal(preview.effects.sourceAir.unknown, 1); assert.ok(preview.blockers.some(b => b.includes('Source selection')));
  const missing = previewBuildFile(f.file, f.destination, dimension(f.destination), { x: 1000, y: 2, z: 1000 }, () => {}, [], { airMode: 'skip' });
  assert.equal(missing.counts.unknown, 125); assert.equal(missing.counts.skippedAir, 0); assert.equal(missing.copyEligible, false);
  const v = fixture(t, true), checked = readBuildFile(v.file);
  assert.ok(checked.volume.palette.some(s => s?.Name === 'minecraft:structure_void'));
  assert.equal(isAir({ Name: 'minecraft:structure_void' }), false);
  const blocked = previewBuildFile(v.file, v.destination, dimension(v.destination), anchor, () => {}, [], { airMode: 'skip' });
  assert.equal(blocked.copyEligible, false); assert.equal(blocked.effects.sourceAir.structureVoid, 1); assert.equal(blocked.counts.skippedAir, 26);
  assert.match(blocked.blockers.join(' '), /structure_void/);
  assert.throws(() => previewBuildFile(f.file, f.destination, dimension(f.destination), anchor, () => {}, [], { airMode: 'invent-air' }), { code: 'TRANSFER_AIR_MODE' });
});
