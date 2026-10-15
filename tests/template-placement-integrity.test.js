import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBlockWorld, state } from './transfer-fixtures.js';
import { placementWorld } from './placement-fixtures.js';
import { inspectWorld } from '../engine/world.js';
import { sha } from '../engine/build-archive.js';
import { createSparseSelection } from '../engine/sparse-selection.js';
import { captureTemplateStream } from '../engine/template-capture.js';
import { previewTemplatePlacement, createTemplatePlacedCopy } from '../engine/template-placement.js';

const dimension = world => world.dimensions.find(value => value.id === 'minecraft:overworld').key;
const hashes = root => Object.fromEntries(fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
  const file = path.join(entry.parentPath, entry.name);
  return [path.relative(root, file), sha(fs.readFileSync(file))];
}));
function fixture(t, sourceBlock = 'stone') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'worldrenew-placement-integrity-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = makeBlockWorld(path.join(base, 'source'), { version: '26.2', dataVersion: 4903, block: () => state(sourceBlock) });
  const sourceWorld = inspectWorld(source), file = path.join(base, 'build.wrbuild');
  captureTemplateStream(file, sourceWorld, dimension(sourceWorld), createSparseSelection({ x: 3, y: 1, z: 3 }, { x: 3, y: 1, z: 3 }));
  const destination = inspectWorld(placementWorld(path.join(base, 'destination'))), anchor = { x: 21, y: 3, z: 21 };
  const review = previewTemplatePlacement(file, destination, dimension(destination), anchor);
  assert.deepEqual(review.blockers, []);
  return { base, source, file, destination, anchor, review, sourceBefore: hashes(source), before: hashes(destination.root) };
}
function stageDirectory(f) {
  const name = fs.readdirSync(f.base).find(name => name.startsWith('.WorldRenew-placement-') && name.endsWith('.partial'));
  return name ? path.join(f.base, name) : null;
}
function planDirectory(f) {
  const stage = stageDirectory(f); if (!stage) return null;
  const name = fs.readdirSync(stage).find(name => name.startsWith('.worldrenew-template-plan-'));
  return name ? path.join(stage, name) : null;
}
function attempt(f, options) {
  try {
    createTemplatePlacedCopy(f.file, f.destination, dimension(f.destination), f.anchor, f.base, { confirmedClosed: true, reviewDigest: f.review.reviewDigest, ...options });
    return null;
  } catch (error) { return error; }
}
function assertFailedWithoutPublication(f, error, code) {
  assert.ok(error, 'Mutated scratch evidence must not produce a published placement.');
  if (Array.isArray(code)) assert.ok(code.includes(error.code), `Expected ${code.join(' or ')}, received ${error.code}.`);
  else assert.equal(error.code, code);
  assert.deepEqual(hashes(f.source), f.sourceBefore);
  assert.deepEqual(hashes(f.destination.root), f.before);
  assert.equal(fs.readdirSync(f.base).some(name => name.startsWith('WorldRenew-placement-')), false);
  const stage = stageDirectory(f); assert.ok(stage, 'A verified backup should remain after the working copy is discarded.');
  assert.deepEqual(fs.readdirSync(stage, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name), ['backup']);
  assert.deepEqual(hashes(path.join(stage, 'backup/world')), f.before);
  assert.match(fs.readFileSync(path.join(stage, 'operation.json'), 'utf8'), /failed-working-copy-discarded/);
}

test('prepared region cannot acquire accepted timestamp changes during post-preparation hashing', t => {
  const f = fixture(t); let mutated = false;
  const error = attempt(f, { shouldCancel() {
    // Target the exact trust boundary after the region helper has verified its
    // output. In the vulnerable path this callback's changed timestamp was
    // accepted as the expected digest, while every selected raw hash still fit.
    if (mutated || !new Error().stack.includes('at hashBatched ')) return false;
    const plan = planDirectory(f); if (!plan) return false;
    const name = fs.readdirSync(plan).find(name => name.startsWith('prepared-') && name.endsWith('.mca'));
    if (!name) return false;
    const fd = fs.openSync(path.join(plan, name), 'r+');
    try {
      const bytes = Buffer.alloc(4), timestamp = 4096 + 3 * 4; // Existing x=3,z=0 lies outside the 3×3 lighting border.
      fs.readSync(fd, bytes, 0, 4, timestamp); bytes.writeUInt32BE(bytes.readUInt32BE() ^ 1); fs.writeSync(fd, bytes, 0, 4, timestamp);
      mutated = true;
    } finally { fs.closeSync(fd); }
    return false;
  } });
  assert.equal(mutated, true, 'The regression must exercise post-preparation hashing.');
  assertFailedWithoutPublication(f, error, 'PLACEMENT_STALE');
});

function changeMask(value) {
  if (!value || typeof value !== 'object') return false;
  if (typeof value.mask === 'string') {
    const mask = Buffer.from(value.mask, 'base64'); assert.equal(mask.length, 512);
    const before = 1 * 256 + 3 * 16 + 3, after = before + 1;
    assert.ok(mask[before >> 3] & (1 << (before & 7)));
    mask[before >> 3] &= ~(1 << (before & 7)); mask[after >> 3] |= 1 << (after & 7);
    value.mask = mask.toString('base64'); return true;
  }
  return Object.values(value).some(changeMask);
}

for (const kind of ['raw', 'mask']) test(`cached source ${kind} changes cannot redefine a reviewed sparse placement`, t => {
  const f = fixture(t); let mutated = false;
  const error = attempt(f, { onProgress(event) {
    if (mutated || event.phase !== 'Preparing template placement') return;
    // Ignore the fresh public preview. Only mutate the second plan, built from
    // the owned working copy after backup creation, before typed preflight.
    const plan = planDirectory(f); if (!plan) return;
    const sources = path.join(plan, 'sources'), suffix = kind === 'raw' ? '.nbt' : '.json';
    const name = fs.readdirSync(sources).find(name => name.endsWith(suffix)); assert.ok(name);
    const target = path.join(sources, name);
    if (kind === 'raw') {
      const bytes = fs.readFileSync(target), before = Buffer.from('minecraft:stone'), after = Buffer.from('minecraft:glass'), offset = bytes.indexOf(before);
      assert.ok(offset >= 0); assert.equal(before.length, after.length); after.copy(bytes, offset); fs.writeFileSync(target, bytes);
    } else {
      const metadata = JSON.parse(fs.readFileSync(target, 'utf8'));
      assert.equal(changeMask(metadata), true); fs.writeFileSync(target, JSON.stringify(metadata));
    }
    mutated = true;
  } });
  assert.equal(mutated, true, 'The regression must modify saved source evidence before preflight.');
  assertFailedWithoutPublication(f, error, 'PLACEMENT_PLAN');
});

function firstRegionPlan(f) {
  const plan = planDirectory(f); if (!plan) return null;
  const parent = path.join(plan, 'regions'), entry = fs.readdirSync(parent, { withFileTypes: true }).find(entry => entry.isDirectory());
  return entry ? path.join(parent, entry.name) : null;
}

test('rewritten expected hashes cannot replace the authenticated placement evidence', t => {
  const f = fixture(t); let mutated = false;
  const error = attempt(f, { onProgress(event) {
    if (mutated || event.phase !== 'Placing template region') return;
    const region = firstRegionPlan(f); assert.ok(region);
    const file = path.join(region, 'expected.json'), expected = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(expected.length > 0); expected[0].sha256 = '0'.repeat(64); fs.writeFileSync(file, JSON.stringify(expected)); mutated = true;
  } });
  assert.equal(mutated, true);
  assertFailedWithoutPublication(f, error, 'PLACEMENT_PLAN');
});

test('deleting a lighting-only patch and its authentication cannot omit reviewed chunks', t => {
  const f = fixture(t); let mutated = false;
  const error = attempt(f, { onProgress(event) {
    if (mutated || event.phase !== 'Placing template region') return;
    const region = firstRegionPlan(f); assert.ok(region);
    const name = fs.readdirSync(region).find(name => name.endsWith('.patches') && fs.readFileSync(path.join(region, name), 'utf8').trim() === '');
    assert.ok(name, 'Fixture must contain a lighting-only chunk contribution.');
    fs.unlinkSync(path.join(region, name)); fs.unlinkSync(path.join(region, `${name}.auth`)); mutated = true;
  } });
  assert.equal(mutated, true);
  assertFailedWithoutPublication(f, error, ['ENOENT', 'PLACEMENT_PLAN']);
});

test('deleted output digests cannot reclassify a restored planned region as untouched', t => {
  const f = fixture(t, 'oak_planks'); let mutated = false;
  assert.equal(f.review.effects.changedBlocks, '1');
  const error = attempt(f, { onProgress(event) {
    if (mutated || event.phase !== 'Verifying placed files') return;
    const stage = stageDirectory(f), region = firstRegionPlan(f); assert.ok(stage); assert.ok(region);
    const relative = path.join('dimensions/minecraft/overworld/region', 'r.0.0.mca');
    const original = path.join(stage, 'backup/world', relative), working = path.join(event.file, relative);
    assert.notEqual(sha(fs.readFileSync(working)), sha(fs.readFileSync(original)), 'The prepared region must already contain the reviewed placement.');
    fs.copyFileSync(original, working);
    fs.unlinkSync(path.join(region, 'output.sha256')); fs.unlinkSync(path.join(region, 'output.sha256.auth')); mutated = true;
  } });
  assert.equal(mutated, true);
  assertFailedWithoutPublication(f, error, ['ENOENT', 'PLACEMENT_PLAN']);
});
