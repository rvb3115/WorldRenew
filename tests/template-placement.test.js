import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nbt, writeDat } from './fixtures.js';
import { makeBlockWorld, state } from './transfer-fixtures.js';
import { placementWorld } from './placement-fixtures.js';
import { inspectWorld } from '../engine/world.js';
import { createChunkReader, decodeSection, isAir, stateKey } from '../engine/chunks.js';
import { sha } from '../engine/build-archive.js';
import { replaceRegionRecords } from '../engine/region-writer.js';
import { compound, field, plain, readTypedNBT, removeField, setField, tag, writeTypedNBT } from '../engine/typed-nbt.js';
import { createSparseSelection } from '../engine/sparse-selection.js';
import { captureTemplateStream } from '../engine/template-capture.js';
import { iterateTemplate, selectedTemplateBlocks, writeTemplateStream } from '../engine/template-stream.js';
import { previewTemplatePlacement, createTemplatePlacedCopy } from '../engine/template-placement.js';

// Every world here is generated under a private test directory. No real save is
// opened, and the assertions never depend on the user's installed game data.
const dimension = world => world.dimensions.find(value => value.id === 'minecraft:overworld').key;
const mod = (value, size) => (value % size + size) % size;
const cellKey = ({ x, y, z }) => `${x},${y},${z}`;
const regionFile = (root, x, z, store = 'region') => path.join(root, 'dimensions/minecraft/overworld', store, `r.${Math.floor(x / 32)}.${Math.floor(z / 32)}.mca`);
const slotOf = (x, z) => mod(x, 32) + mod(z, 32) * 32;
const hashes = root => Object.fromEntries(fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
  const file = path.join(entry.parentPath, entry.name);
  return [path.relative(root, file), sha(fs.readFileSync(file))];
}));
function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'worldrenew-template-placement-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}
function readRecord(root, x, z, store = 'region') {
  const world = inspectWorld(root), dim = world.dimensions.find(value => value.key === dimension(world));
  return createChunkReader(root, dim).read(x, z, store);
}
function editTerrain(root, x, z, edit) {
  const file = regionFile(root, x, z), typed = readTypedNBT(readRecord(root, x, z).raw);
  edit(typed);
  fs.writeFileSync(file, replaceRegionRecords(fs.readFileSync(file), new Map([[slotOf(x, z), writeTypedNBT(typed)]])));
}
function writeSupporting(root, x, z, store, raw) {
  const file = regionFile(root, x, z, store), count = Math.ceil((raw.length + 5) / 4096), bytes = Buffer.alloc((2 + count) * 4096);
  bytes.writeUInt32BE(512 + count, slotOf(x, z) * 4); bytes.writeUInt32BE(raw.length + 1, 8192); bytes[8196] = 3; raw.copy(bytes, 8197);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
}
function capture(base, source, selection, name = 'build.wrbuild') {
  const world = inspectWorld(source), file = path.join(base, name);
  captureTemplateStream(file, world, dimension(world), selection);
  return file;
}
function exactField(raw, name) { return writeTypedNBT(compound({ preserved: field(readTypedNBT(raw), name) })); }
function blockReader(root) {
  const world = inspectWorld(root), dim = world.dimensions.find(value => value.key === dimension(world));
  const reader = createChunkReader(root, dim), sections = new Map();
  return (x, y, z) => {
    const cx = Math.floor(x / 16), cz = Math.floor(z / 16), sy = Math.floor(y / 16), key = `${cx},${sy},${cz}`;
    if (!sections.has(key)) sections.set(key, decodeSection(reader.read(cx, cz).nbt.sections.find(section => section.Y === sy)));
    const section = sections.get(key), index = mod(y, 16) * 256 + mod(z, 16) * 16 + mod(x, 16);
    return section.palette[section.indices[index]];
  };
}
function selected(file) {
  const records = [...iterateTemplate(file)];
  return { header: records[0].header, cells: records.filter(record => record.type === 'chunk').flatMap(record => [...selectedTemplateBlocks(record.chunk)]) };
}
function assertPlacedCells(file, destination, placed, anchor, airMode) {
  const source = selected(file), bounds = source.header.source.bounds, offset = { x: anchor.x - bounds.minX, y: anchor.y - bounds.minY, z: anchor.z - bounds.minZ };
  const expected = new Map(source.cells.map(cell => [cellKey({ x: cell.x + offset.x, y: cell.y + offset.y, z: cell.z + offset.z }), cell.state]));
  const before = blockReader(destination), after = blockReader(placed);
  // Check every excluded cell within the bounding box, not just the selected
  // states. A disconnected mask must never expand to its enclosing rectangle.
  for (let y = bounds.minY; y <= bounds.maxY; y++) for (let z = bounds.minZ; z <= bounds.maxZ; z++) for (let x = bounds.minX; x <= bounds.maxX; x++) {
    const target = { x: x + offset.x, y: y + offset.y, z: z + offset.z }, captured = expected.get(cellKey(target));
    const wanted = !captured || (airMode === 'skip' && isAir(captured)) ? before(target.x, target.y, target.z) : captured;
    assert.equal(stateKey(after(target.x, target.y, target.z)), stateKey(wanted), `Unexpected block at ${cellKey(target)} in ${airMode} mode.`);
  }
}
const chest = (x, y, z) => nbt({ id: [8, 'minecraft:chest'], x: [3, x], y: [3, y], z: [3, z], Items: [9, { type: 10, values: [{ Slot: [1, 0], id: [8, 'minecraft:diamond'], count: [3, 12], future: [4, 9007199254740993n] }] }], future_inventory: [7, Buffer.from([255, 0, 128, 3])] });
function putAttachment(root, x, y, z, kind) {
  const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
  if (kind === 'entities') {
    writeSupporting(root, cx, cz, 'entities', nbt({ DataVersion: [3, 4903], Position: [11, [cx, cz]], Entities: [9, { type: 10, values: [{ id: [8, 'minecraft:armor_stand'], UUID: [11, [1, 2, 3, 4]], Pos: [9, { type: 6, values: [x, y, z] }] }] }] }));
  } else if (kind === 'poi') {
    const packed = (BigInt.asUintN(26, BigInt(x)) << 38n) | (BigInt.asUintN(26, BigInt(z)) << 12n) | BigInt.asUintN(12, BigInt(y));
    writeSupporting(root, cx, cz, 'poi', nbt({ DataVersion: [3, 4903], Sections: [10, { [Math.floor(y / 16)]: [10, { Valid: [1, 1], Records: [9, { type: 10, values: [{ pos: [4, BigInt.asIntN(64, packed)], type: [8, 'minecraft:home'], free_tickets: [3, 1] }] }] }] }] }));
  } else {
    const record = kind === 'block_entities' ? readTypedNBT(chest(x, y, z)) : compound({ x: tag(3, x), y: tag(3, y), z: tag(3, z), i: tag(8, kind === 'fluid_ticks' ? 'minecraft:water' : 'minecraft:stone'), t: tag(3, 20), p: tag(3, 0) });
    editTerrain(root, cx, cz, typed => setField(typed, kind, tag(9, [record], 10)));
  }
}
function basicFixture(t, options = {}) {
  const base = setup(t), source = makeBlockWorld(path.join(base, 'source'), { version: '26.2', dataVersion: 4903, block: () => state('oak_planks'), ...options });
  const selection = createSparseSelection({ x: 3, y: 1, z: 3 }, { x: 3, y: 1, z: 3 });
  const file = capture(base, source, selection), destination = inspectWorld(placementWorld(path.join(base, 'destination'))), anchor = { x: 21, y: 3, z: 21 };
  return { base, source, selection, file, destination, anchor };
}
function sparseFixture(t) {
  const base = setup(t), anchor = { x: 20, y: 2, z: 20 };
  const source = makeBlockWorld(path.join(base, 'source'), { version: '26.2', dataVersion: 4903, block: (x, y, z) => {
    if (x === 4 && y === 1 && z === 4) return state('chest', { facing: 'north', type: 'single', waterlogged: 'false' });
    if (y === 2 && z === 3 && x >= 3 && x <= 5) return state(['air', 'cave_air', 'void_air'][x - 3]);
    if (x === 12 && y === 0 && z === 12) return state('oak_stairs', { facing: 'west', half: 'top', shape: 'outer_left', waterlogged: 'false' });
    return state('oak_planks');
  } });
  putAttachment(source, 4, 1, 4, 'block_entities');
  const selection = createSparseSelection({ x: 2, y: 0, z: 2 }, { x: 6, y: 3, z: 6 }).removeBlock(4, 1, 4).addBlock(12, 0, 12);
  const destinationRoot = placementWorld(path.join(base, 'destination'), { block: (x, y, z) => state(x === 6 && y === 3 && z === 6 ? 'chest' : 'stone') });
  putAttachment(destinationRoot, 22, 3, 22, 'block_entities');
  editTerrain(destinationRoot, 1, 1, root => setField(root, 'future_opaque', readTypedNBT(nbt({ bytes: [7, Buffer.from([0, 255, 128])], long: [4, -9223372036854775807n], float: [5, NaN], text: [8, 'future\0🌲'] }))));
  // Opaque player data is copied without parsing or normalizing inventories.
  writeDat(path.join(destinationRoot, 'playerdata/00000000-0000-0000-0000-000000000001.dat'), { Inventory: [9, { type: 10, values: [{ Slot: [1, 2], id: [8, 'minecraft:diamond'], count: [3, 64], future: [4, 9223372036854775807n] }] }], future_player: [7, Buffer.from([255, 4, 0, 128])] });
  const file = capture(base, source, selection), destination = inspectWorld(destinationRoot);
  return { base, source, selection, file, destination, anchor };
}

for (const airMode of ['include', 'skip']) test(`v2 ${airMode} placement honors sparse air and preserves excluded inventories, players and opaque metadata`, t => {
  const f = sparseFixture(t), sourceBefore = hashes(f.source), before = hashes(f.destination.root), originalTerrain = readRecord(f.destination.root, 1, 1).raw;
  const plan = previewTemplatePlacement(f.file, f.destination, dimension(f.destination), f.anchor, { airMode });
  assert.deepEqual(plan.blockers, []); assert.equal(plan.copyEligible, true); assert.equal(plan.schemaVersion, 2);
  assert.equal(plan.effects.changedBlocks, airMode === 'include' ? '100' : '97');
  assert.equal(plan.counts.skippedAir, airMode === 'skip' ? '3' : '0');
  assert.equal(plan.counts.carved, airMode === 'include' ? '3' : '0');
  const result = createTemplatePlacedCopy(f.file, f.destination, dimension(f.destination), f.anchor, f.base, { confirmedClosed: true, reviewDigest: plan.reviewDigest, airMode });
  assertPlacedCells(f.file, f.destination.root, result.world, f.anchor, airMode);
  assert.deepEqual(hashes(f.source), sourceBefore); assert.deepEqual(hashes(f.destination.root), before); assert.deepEqual(hashes(result.backup), before);
  const placedTerrain = readRecord(result.world, 1, 1).raw;
  for (const name of ['block_entities', 'future_opaque']) assert.deepEqual(exactField(placedTerrain, name), exactField(originalTerrain, name));
  const outputFiles = hashes(result.world);
  for (const [name, digest] of Object.entries(before)) if (!name.includes('/region/')) assert.equal(outputFiles[name], digest, name);
  const report = JSON.parse(fs.readFileSync(result.report));
  assert.equal(report.gameLoadTested, false); assert.equal(report.airMode, airMode); assert.deepEqual(report.effects, plan.effects);
  assert.equal(fs.readdirSync(f.base).some(name => name.endsWith('.partial')), false);
});

test('arbitrary anchors cross negative chunk, region and section boundaries without filling exclusions', t => {
  const base = setup(t), source = placementWorld(path.join(base, 'source'), { block: (x, y, z) => state((x + y + z) % 3 === 0 ? 'cave_air' : 'oak_planks') });
  const selection = createSparseSelection({ x: 14, y: 14, z: 2 }, { x: 17, y: 17, z: 5 }).removeBlock(15, 15, 3).addBlock(20, 18, 8);
  const file = capture(base, source, selection), destination = inspectWorld(placementWorld(path.join(base, 'destination'), { originX: -2, originZ: -2 })), anchor = { x: -2, y: -2, z: -12 };
  const before = hashes(destination.root), plan = previewTemplatePlacement(file, destination, dimension(destination), anchor);
  assert.deepEqual(plan.blockers, []);
  const result = createTemplatePlacedCopy(file, destination, dimension(destination), anchor, base, { confirmedClosed: true, reviewDigest: plan.reviewDigest });
  assertPlacedCells(file, destination.root, result.world, anchor, 'include');
  assert.deepEqual(hashes(destination.root), before); assert.deepEqual(hashes(result.backup), before);
  assert.ok(JSON.parse(fs.readFileSync(result.report)).modifiedRegions.length >= 2);
});

test('closed-world confirmation and air-mode review binding prevent unreviewed output', t => {
  const f = sparseFixture(t), include = previewTemplatePlacement(f.file, f.destination, dimension(f.destination), f.anchor);
  const skip = previewTemplatePlacement(f.file, f.destination, dimension(f.destination), f.anchor, { airMode: 'skip' }), before = fs.readdirSync(f.base).sort();
  assert.notEqual(skip.reviewDigest, include.reviewDigest);
  assert.throws(() => createTemplatePlacedCopy(f.file, f.destination, dimension(f.destination), f.anchor, f.base, { reviewDigest: include.reviewDigest }), { code: 'WORLD_OPEN' });
  assert.throws(() => createTemplatePlacedCopy(f.file, f.destination, dimension(f.destination), f.anchor, f.base, { confirmedClosed: true, reviewDigest: include.reviewDigest, airMode: 'skip' }), { code: 'PLACEMENT_STALE' });
  assert.deepEqual(fs.readdirSync(f.base).sort(), before);
});

test('changed archive and destination evidence invalidate reviewed placement before copying', t => {
  const f = basicFixture(t), plan = previewTemplatePlacement(f.file, f.destination, dimension(f.destination), f.anchor);
  const records = [...iterateTemplate(f.file)], header = { ...records[0].header, future_review_field: 'changed' }, replacement = path.join(f.base, 'changed.wrbuild');
  writeTemplateStream(replacement, header, records.filter(record => record.type === 'chunk').map(record => record.chunk));
  fs.renameSync(replacement, f.file);
  assert.throws(() => createTemplatePlacedCopy(f.file, f.destination, dimension(f.destination), f.anchor, f.base, { confirmedClosed: true, reviewDigest: plan.reviewDigest }), { code: 'PLACEMENT_STALE' });
  const next = previewTemplatePlacement(f.file, f.destination, dimension(f.destination), f.anchor);
  editTerrain(f.destination.root, 1, 1, root => setField(root, 'future_change', tag(8, 'new metadata')));
  assert.throws(() => createTemplatePlacedCopy(f.file, f.destination, dimension(f.destination), f.anchor, f.base, { confirmedClosed: true, reviewDigest: next.reviewDigest }), { code: 'PLACEMENT_STALE' });
  assert.equal(fs.readdirSync(f.base).some(name => name.includes('WorldRenew')), false);
});

test('portable placement succeeds after the generated source world goes offline', t => {
  const f = basicFixture(t), sourceBefore = hashes(f.source), offline = f.source + '-offline';
  fs.renameSync(f.source, offline);
  const plan = previewTemplatePlacement(f.file, f.destination, dimension(f.destination), f.anchor);
  assert.deepEqual(plan.blockers, []);
  const result = createTemplatePlacedCopy(f.file, f.destination, dimension(f.destination), f.anchor, f.base, { confirmedClosed: true, reviewDigest: plan.reviewDigest });
  assertPlacedCells(f.file, f.destination.root, result.world, f.anchor, 'include');
  assert.deepEqual(hashes(offline), sourceBefore);
});

test('unsupported source or destination versions and dimensions fail closed', t => {
  const f = basicFixture(t, { version: '26.3', dataVersion: 5023 });
  const unsupported = previewTemplatePlacement(f.file, f.destination, dimension(f.destination), f.anchor);
  assert.equal(unsupported.copyEligible, false); assert.match(unsupported.blockers.join(' '), /26\.2|4903/);
  const supported = basicFixture(t), root = placementWorld(path.join(supported.base, 'newer-destination'), { version: '26.3', dataVersion: 5023 });
  const newer = inspectWorld(root), blocked = previewTemplatePlacement(supported.file, newer, dimension(newer), supported.anchor);
  assert.equal(blocked.copyEligible, false); assert.match(blocked.blockers.join(' '), /26\.2|4903/);
  fs.cpSync(path.join(supported.destination.root, 'dimensions/minecraft/overworld'), path.join(supported.destination.root, 'dimensions/minecraft/the_nether'), { recursive: true });
  const twoDimensions = inspectWorld(supported.destination.root), nether = twoDimensions.dimensions.find(value => value.id === 'minecraft:the_nether').key;
  const mismatch = previewTemplatePlacement(supported.file, twoDimensions, nether, supported.anchor);
  assert.equal(mismatch.copyEligible, false); assert.match(mismatch.blockers.join(' '), /same vanilla dimension/);
});

test('missing selected terrain, incomplete lighting neighbors and protected chunks cannot become air', t => {
  const f = basicFixture(t), dim = dimension(f.destination);
  editTerrain(f.destination.root, 1, 1, root => removeField(field(root, 'sections').value.find(section => plain(field(section, 'Y')) === 0), 'block_states'));
  const unknown = previewTemplatePlacement(f.file, f.destination, dim, f.anchor, { airMode: 'skip' });
  assert.equal(unknown.copyEligible, false); assert.match(unknown.blockers.join(' '), /unknown|known|missing/i);
  const other = basicFixture(t), otherDim = dimension(other.destination);
  editTerrain(other.destination.root, 0, 0, root => setField(root, 'Status', tag(8, 'minecraft:noise')));
  const ring = previewTemplatePlacement(other.file, other.destination, otherDim, other.anchor);
  assert.equal(ring.copyEligible, false); assert.match(ring.blockers.join(' '), /complete|lighting|full/i);
  const protectedFixture = basicFixture(t), protectedDim = dimension(protectedFixture.destination);
  const protectedPlan = previewTemplatePlacement(protectedFixture.file, protectedFixture.destination, protectedDim, protectedFixture.anchor, { protection: [{ dimension: protectedDim, x: 0, z: 0 }] });
  assert.equal(protectedPlan.copyEligible, false); assert.match(protectedPlan.blockers.join(' '), /protected/i);
});

for (const name of ['chest', 'water', 'structure_void']) test(`selected ${name} remains unsupported in a portable v2 template`, t => {
  const f = basicFixture(t, { block: () => state(name) }), plan = previewTemplatePlacement(f.file, f.destination, dimension(f.destination), f.anchor, { airMode: 'skip' });
  assert.equal(plan.copyEligible, false); assert.match(plan.blockers.join(' '), new RegExp(name));
});

for (const kind of ['block_entities', 'entities', 'block_ticks', 'fluid_ticks', 'poi']) test(`selected source and destination ${kind} retain existing relocation safety gates`, t => {
  const f = basicFixture(t); putAttachment(f.source, 3, 1, 3, kind);
  const file = capture(f.base, f.source, f.selection, 'attached.wrbuild'), sourcePlan = previewTemplatePlacement(file, f.destination, dimension(f.destination), f.anchor);
  assert.equal(sourcePlan.copyEligible, false); assert.match(sourcePlan.blockers.join(' '), /relocation|entities|updates|POI|inventor/i);
  putAttachment(f.destination.root, f.anchor.x, f.anchor.y, f.anchor.z, kind);
  const targetPlan = previewTemplatePlacement(f.file, f.destination, dimension(f.destination), f.anchor);
  assert.equal(targetPlan.copyEligible, false); assert.match(targetPlan.blockers.join(' '), /entit|updates|poi|tick|occupied/i);
  assert.throws(() => createTemplatePlacedCopy(file, f.destination, dimension(f.destination), f.anchor, f.base, { confirmedClosed: true, reviewDigest: sourcePlan.reviewDigest }), { code: 'PLACEMENT_BLOCKED' });
  assert.equal(fs.readdirSync(f.base).some(name => name.includes('WorldRenew')), false);
});

for (const phase of ['Placing template region', 'Verifying placed files']) test(`cancellation during ${phase} discards the working copy and publishes no result`, t => {
  const f = basicFixture(t), before = hashes(f.destination.root), sourceBefore = hashes(f.source), plan = previewTemplatePlacement(f.file, f.destination, dimension(f.destination), f.anchor), controller = new AbortController();
  let reached = false, cancel = false;
  const cancellation = phase === 'Placing template region' ? { signal: controller.signal } : { shouldCancel: () => cancel };
  assert.throws(() => createTemplatePlacedCopy(f.file, f.destination, dimension(f.destination), f.anchor, f.base, { confirmedClosed: true, reviewDigest: plan.reviewDigest, ...cancellation, onProgress(event) {
    if (event.phase === phase) { reached = true; cancel = true; controller.abort(); }
  } }), { code: 'TEMPLATE_CANCELLED' });
  assert.equal(reached, true); assert.deepEqual(hashes(f.source), sourceBefore); assert.deepEqual(hashes(f.destination.root), before);
  const operations = fs.readdirSync(f.base).filter(name => name.includes('WorldRenew'));
  assert.equal(operations.length, 1); assert.ok(operations[0].startsWith('.') && operations[0].endsWith('.partial'));
  const stage = path.join(f.base, operations[0]), directories = fs.readdirSync(stage, { withFileTypes: true }).filter(entry => entry.isDirectory());
  assert.deepEqual(directories.map(entry => entry.name), ['backup']);
  assert.deepEqual(hashes(path.join(stage, 'backup/world')), before);
  assert.match(fs.readFileSync(path.join(stage, 'operation.json'), 'utf8'), /failed-working-copy-discarded/);
});

test('aborted previews and malformed archives leave no published output', t => {
  const f = basicFixture(t), before = fs.readdirSync(f.base).sort();
  assert.throws(() => previewTemplatePlacement(f.file, f.destination, dimension(f.destination), f.anchor, { signal: AbortSignal.abort() }), { code: 'TEMPLATE_CANCELLED' });
  const bytes = fs.readFileSync(f.file); bytes[bytes.length - 2] ^= 1; fs.writeFileSync(f.file, bytes);
  assert.throws(() => createTemplatePlacedCopy(f.file, f.destination, dimension(f.destination), f.anchor, f.base, { confirmedClosed: true, reviewDigest: 'cannot-authorize-corruption' }));
  assert.deepEqual(fs.readdirSync(f.base).sort(), before);
});
