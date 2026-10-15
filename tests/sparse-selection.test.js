import test from 'node:test';
import assert from 'node:assert/strict';
import { SparseSelection, createSparseSelection, deserializeSparseSelection, validateSelectionBounds, SPARSE_SELECTION_FORMAT } from '../engine/sparse-selection.js';

const box = (minX, maxX, minY, maxY, minZ, maxZ) => ({ minX, maxX, minY, maxY, minZ, maxZ });
const corners = (a, b, options) => createSparseSelection({ x: a[0], y: a[1], z: a[2] }, { x: b[0], y: b[1], z: b[2] }, options);
function maskCoordinates(section) {
  const cells = [];
  assert.equal(section.mask.length, 512);
  for (let i = 0; i < 4096; i++) if (section.mask[i >> 3] & (1 << (i & 7))) cells.push(`${section.x * 16 + (i & 15)},${section.y * 16 + (i >> 8)},${section.z * 16 + ((i >> 4) & 15)}`);
  assert.equal(cells.length, section.selectedCount);
  assert.ok(cells.length > 0);
  return cells;
}
function selectionCells(selection) { return new Set([...selection.iterateSections()].flatMap(maskCoordinates)); }

test('corner crossing supports inclusive negative coordinates and all six drag directions', () => {
  const selection = corners([17, 16, -17], [-1, -1, 1]);
  assert.deepEqual(selection.bounds, box(-1, 17, -1, 16, -17, 1));
  assert.equal(selection.blockCount, 19n * 18n * 19n);
  assert.equal(selection.boxCount, 1);
  const cells = selectionCells(selection);
  assert.equal(BigInt(cells.size), selection.blockCount);
  for (const point of ['-1,-1,-17', '17,16,1', '0,0,0']) assert.ok(cells.has(point));
  assert.equal(selection.contains(-2, 0, 0), false);
  assert.equal(selection.contains(-1, -1, -17), true);
  for (let mask = 0; mask < 8; mask++) {
    const a = [mask & 1 ? 1 : -1, mask & 2 ? 2 : -2, mask & 4 ? 3 : -3], b = a.map(n => -n);
    assert.deepEqual(corners(a, b).bounds, box(-1, 1, -2, 2, -3, 3));
  }
});

test('refinement removes and restores cells without duplicating overlaps', () => {
  const selection = corners([0, 0, 0], [4, 4, 4]);
  selection.removeBlock(2, 2, 2);
  assert.equal(selection.blockCount, 124n);
  assert.equal(selection.contains(2, 2, 2), false);
  assert.equal(selection.boxCount, 6);
  assert.equal(selectionCells(selection).size, 124);
  selection.addBlock(2, 2, 2).addBlock(2, 2, 2);
  assert.equal(selection.blockCount, 125n);
  assert.equal(selection.boxCount, 1);
  selection.addBox(box(3, 5, 3, 5, 3, 5));
  assert.equal(selection.blockCount, 125n + 27n - 8n);
  assert.equal(BigInt(selectionCells(selection).size), selection.blockCount);
  selection.removeBox(box(-100, 100, -100, 100, -100, 100));
  assert.equal(selection.blockCount, 0n);
  assert.equal(selection.bounds, null);
  assert.deepEqual([...selection.iterateChunks()], []);
});

test('disconnected pieces skip enormous empty coordinate gaps and order chunks z then x', () => {
  const selection = new SparseSelection().addBlock(30_000_000, 30_000_000, 30_000_000).addBlock(-30_000_000, -30_000_000, -30_000_000).addBlock(-30_000_000, 0, 30_000_000);
  const chunks = [...selection.iterateChunks()];
  assert.deepEqual(chunks.map(({ x, z }) => [x, z]), [[-1_875_000, -1_875_000], [-1_875_000, 1_875_000], [1_875_000, 1_875_000]]);
  assert.equal(selection.blockCount, 3n);
  assert.equal(selectionCells(selection).size, 3);
  const vertical = new SparseSelection().addBlock(0, -30_000_000, 0).addBlock(0, 30_000_000, 0);
  assert.deepEqual([...vertical.iterateSections()].map(s => s.y), [-1_875_000, 1_875_000]);
});

test('sections use y/z/x bits and preserve membership independently from block state or air', () => {
  const selection = new SparseSelection().addBlock(0, 0, 0).addBlock(15, 0, 0).addBlock(0, 0, 1).addBlock(0, 1, 0).addBlock(15, 15, 15).addBlock(-1, -1, -1);
  const sections = [...selection.iterateSections()];
  assert.equal(sections.length, 2);
  assert.deepEqual(sections.map(s => [s.x, s.z, s.y]), [[-1, -1, -1], [0, 0, 0]]);
  const positive = sections[1];
  for (const bit of [0, 15, 16, 256, 4095]) assert.ok(positive.mask[bit >> 3] & (1 << (bit & 7)));
  assert.equal(positive.selectedCount, 5);
  assert.deepEqual([...selectionCells(selection)].sort(), ['-1,-1,-1', '0,0,0', '0,0,1', '0,1,0', '15,0,0', '15,15,15'].sort());
  selection.removeBlock(0, 0, 0);
  assert.equal(selectionCells(selection).has('0,0,0'), false, 'Excluded cells have no bit; there is no implicit air value.');
});

test('world-scale box has exact BigInt count and lazy section/chunk traversal', () => {
  const selection = corners([-30_000_000, -30_000_000, -30_000_000], [30_000_000, 30_000_000, 30_000_000]);
  assert.equal(selection.boxCount, 1);
  assert.equal(selection.blockCount, 60_000_001n ** 3n);
  assert.ok(JSON.stringify(selection).length < 300);
  const chunks = selection.iterateChunks();
  const first = chunks.next().value;
  assert.deepEqual([first.x, first.z], [-1_875_000, -1_875_000]);
  assert.equal(Array.isArray(first.sections), false);
  const section = first.sections.next().value;
  assert.equal(section.y, -1_875_000);
  assert.equal(section.selectedCount, 4096);
  assert.ok(section.mask.every(byte => byte === 255));
  chunks.return(); first.sections.return();
});

test('iterators snapshot edits, report progress and cancel at chunk/section boundaries', () => {
  const selection = corners([0, 0, 0], [31, 31, 0]);
  const events = [], controller = new AbortController();
  const iterator = selection.iterateChunks({ signal: controller.signal, onProgress: event => events.push(event) });
  selection.removeBox(selection.bounds);
  const first = iterator.next().value;
  assert.equal(first.sections.next().value.selectedCount, 256);
  assert.equal(events[0].chunksVisited, 1);
  controller.abort('test');
  assert.throws(() => first.sections.next(), { name: 'AbortError', code: 'ABORT_ERR' });
  assert.throws(() => iterator.next(), { name: 'AbortError', code: 'ABORT_ERR' });
  assert.throws(() => new SparseSelection().iterateChunks({ signal: controller.signal }).next(), { code: 'ABORT_ERR' });
  const duringProgress = new AbortController();
  assert.throws(() => corners([0, 0, 0], [0, 0, 0]).iterateChunks({ signal: duringProgress.signal, onProgress: () => duringProgress.abort() }).next(), { code: 'ABORT_ERR' });
});

test('serialized selections preserve detached top-level and per-box unknown JSON fields', () => {
  const input = { schemaVersion: 1, format: SPARSE_SELECTION_FORMAT, custom: { nested: ['value', { future: true }], precise: '9007199254740993' }, boxes: [{ ...box(-1, 1, 0, 0, 0, 0), futureBoxField: { opaque: 'record' } }] };
  const selection = deserializeSparseSelection(JSON.stringify(input));
  assert.deepEqual(selection.toJSON(), input);
  input.custom.nested[1].future = false;
  const output = selection.toJSON(); output.custom.nested[0] = 'changed'; output.boxes[0].futureBoxField.opaque = 'changed';
  assert.equal(selection.toJSON().custom.nested[0], 'value');
  selection.removeBlock(0, 0, 0).addBlock(0, 0, 0).addBox(box(-1, 1, 0, 0, 0, 0));
  assert.equal(selection.blockCount, 3n);
  assert.equal(selection.toJSON().boxes.filter(b => b.futureBoxField?.opaque === 'record').length, 2);
  assert.deepEqual(deserializeSparseSelection(selection.toJSON()).toJSON(), selection.toJSON());
  const polluted = JSON.parse('{"format":"worldrenew-sparse-selection","schemaVersion":1,"boxes":[],"__proto__":{"polluted":true}}');
  assert.deepEqual(deserializeSparseSelection(polluted).toJSON(), polluted);
  assert.equal({}.polluted, undefined);
});

test('strict deserialization rejects invalid bounds, overlaps, versions and non-JSON data', () => {
  const good = corners([0, 0, 0], [1, 1, 1]).toJSON();
  for (const input of [null, [], {}, '{', { ...good, schemaVersion: 2 }, { ...good, format: 'other' }, { ...good, boxes: null }, { ...good, boxes: [box(2, 1, 0, 0, 0, 0)] }, { ...good, boxes: [good.boxes[0], good.boxes[0]] }, { ...good, boxes: [box(0.5, 1, 0, 0, 0, 0)] }, { ...good, boxes: [box(0, 30_000_001, 0, 0, 0, 0)] }, { ...good, future: undefined }, { ...good, future: NaN }, { ...good, future: new Date() }, { ...good, future: 1n }, { ...good, boxes: Array(3) }]) assert.throws(() => deserializeSparseSelection(input));
  const cyclic = { ...good }; cyclic.self = cyclic; assert.throws(() => deserializeSparseSelection(cyclic), { code: 'SPARSE_SCHEMA' });
  let accessed = false; const getter = { ...good, get future() { accessed = true; return true; } };
  assert.throws(() => deserializeSparseSelection(getter), { code: 'SPARSE_SCHEMA' }); assert.equal(accessed, false);
  const knownGetter = { ...good, get boxes() { accessed = true; return []; } };
  assert.throws(() => deserializeSparseSelection(knownGetter), { code: 'SPARSE_SCHEMA' }); assert.equal(accessed, false);
  assert.throws(() => deserializeSparseSelection({ ...good, [Symbol('future')]: true }), { code: 'SPARSE_SCHEMA' });
  assert.throws(() => deserializeSparseSelection(JSON.stringify(good), { maxSerializedBytes: 30 }), { code: 'SPARSE_SCHEMA' });
  assert.throws(() => deserializeSparseSelection({ ...good, future: 'x'.repeat(1000) }, { maxSerializedBytes: 300 }), { code: 'SPARSE_SCHEMA' });
  assert.deepEqual(validateSelectionBounds(box(-30_000_000, 30_000_000, -30_000_000, 30_000_000, -30_000_000, 30_000_000)), box(-30_000_000, 30_000_000, -30_000_000, 30_000_000, -30_000_000, 30_000_000));
});

test('complexity budgets constrain fragmentation atomically, never total block count', () => {
  const selection = corners([-1_000_000, -1_000_000, -1_000_000], [1_000_000, 1_000_000, 1_000_000], { maxBoxes: 1 });
  const before = selection.toJSON();
  assert.throws(() => selection.removeBlock(0, 0, 0), { code: 'SPARSE_COMPLEXITY' });
  assert.deepEqual(selection.toJSON(), before);
  assert.throws(() => selection.addBlock(2_000_000, 0, 0), { code: 'SPARSE_COMPLEXITY' });
  assert.deepEqual(selection.toJSON(), before);
  assert.throws(() => new SparseSelection([], { maxBoxes: 0 }), { code: 'SPARSE_SCHEMA' });
  const constrained = corners([0, 0, 0], [1, 1, 1], { maxOperations: 3 });
  const constrainedBefore = constrained.toJSON();
  assert.throws(() => constrained.addBlock(3, 3, 3), { code: 'SPARSE_COMPLEXITY' });
  assert.deepEqual(constrained.toJSON(), constrainedBefore);
});

test('generated deterministic edits match a per-cell reference across chunk and section boundaries', () => {
  let seed = 18491; const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0), coordinate = () => next() % 43 - 21;
  const selection = new SparseSelection(), reference = new Set();
  for (let step = 0; step < 160; step++) {
    const x = coordinate(), y = coordinate(), z = coordinate(), dx = next() % 5, dy = next() % 5, dz = next() % 5, add = next() % 3 !== 0;
    const bounds = box(x, x + dx, y, y + dy, z, z + dz);
    selection[add ? 'addBox' : 'removeBox'](bounds);
    for (let by = y; by <= y + dy; by++) for (let bz = z; bz <= z + dz; bz++) for (let bx = x; bx <= x + dx; bx++) reference[add ? 'add' : 'delete'](`${bx},${by},${bz}`);
  }
  assert.equal(selection.blockCount, BigInt(reference.size));
  assert.deepEqual(selectionCells(selection), reference);
  assert.deepEqual(selectionCells(deserializeSparseSelection(selection.toJSON())), reference);
  const coords = [...selection.iterateChunks()].map(({ x, z }) => [x, z]);
  assert.deepEqual(coords, [...coords].sort((a, b) => a[1] - b[1] || a[0] - b[0]));
  assert.equal(new Set(coords.map(c => c.join(','))).size, coords.length);
});
