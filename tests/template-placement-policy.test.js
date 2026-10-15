import test from 'node:test';
import assert from 'node:assert/strict';
import { nbt, emptyRecordTags } from './fixtures.js';
import { sectionFixture, state } from './transfer-fixtures.js';
import {
  validateTemplatePlacementHeader, validateTemplateSourceChunk, validateTemplateDestinationChunk,
  assertDestinationCellWritable, assertDestinationAttachmentsClear
} from '../engine/template-placement-policy.js';

const list = values => [9, { type: 10, values }];
const coordinates = (x = 0, y = 0, z = 0) => ({ x: [3, x], y: [3, y], z: [3, z] });
const entity = (x = 0, y = 0, z = 0, extra = {}) => ({ id: [8, 'minecraft:pig'], Pos: [9, { type: 6, values: [x, y, z] }], ...extra });
function regionTags({ x = 0, z = 0, block = () => state('stone'), sections = [0], extra = {} } = {}) {
  return { ...emptyRecordTags(x, z), DataVersion: [3, 4903], sections: list(sections.map(y => sectionFixture(y, block))), ...extra };
}
function entityRaw(values = [], x = 0, z = 0, extra = {}) {
  return nbt({ ...emptyRecordTags(x, z, 'entities'), DataVersion: [3, 4903], Entities: list(values), ...extra });
}
function packedPos(x, y, z) {
  return BigInt.asIntN(64, (BigInt.asUintN(26, BigInt(x)) << 38n) | (BigInt.asUintN(26, BigInt(z)) << 12n) | BigInt.asUintN(12, BigInt(y)));
}
function poiRaw(records = [], extra = {}) {
  return nbt({ DataVersion: [3, 4903], Sections: [10, { 0: [10, { Records: list(records) }] }], ...extra });
}
function masks(cells) {
  const output = new Map();
  for (const [x, y, z] of cells) {
    const sy = Math.floor(y / 16), local = n => (n % 16 + 16) % 16;
    if (!output.has(sy)) output.set(sy, Buffer.alloc(512));
    const index = local(y) * 256 + local(z) * 16 + local(x); output.get(sy)[index >> 3] |= 1 << (index & 7);
  }
  return [...output].sort(([a], [b]) => a - b).map(([y, mask]) => ({ y, mask }));
}
function source(options = {}) {
  return { x: options.x ?? 0, z: options.z ?? 0, sections: masks(options.cells ?? [[0, 0, 0]]), records: {
    region: nbt(regionTags(options)), entities: options.entities ?? null, poi: options.poi ?? null
  } };
}
function destination(options = {}) {
  const chunk = source(options);
  return validateTemplateDestinationChunk(chunk.records.region, chunk.records.entities, chunk.records.poi, chunk.x, chunk.z);
}
function header() {
  return { format: 'WorldRenew.build', schema: 2, source: { version: '26.2', dataVersion: 4903, dimensionId: 'minecraft:overworld', bounds: { minX: -17, maxX: 20, minY: -2, maxY: 1, minZ: 0, maxZ: 15 } } };
}
const world = () => ({ metadata: { version: '26.2', dataVersion: 4903 }, dimensions: [{ key: 'overworld', id: 'minecraft:overworld' }] });

test('header validates translation and air modes without a small extent or total-cell cap', () => {
  const h = header(), plan = validateTemplatePlacementHeader(h, world(), 'overworld', { x: 10, y: 0, z: -16 }, { airMode: 'skip' });
  assert.deepEqual(plan.offset, { x: 27, y: 2, z: -16 });
  assert.deepEqual(plan.bounds, { minX: 10, maxX: 47, minY: 0, maxY: 3, minZ: -16, maxZ: -1 }); assert.equal(plan.airMode, 'skip');
  h.source.bounds = { minX: -30000000, maxX: 30000000, minY: -64, maxY: 319, minZ: -30000000, maxZ: 30000000 };
  assert.equal(validateTemplatePlacementHeader(h, world(), 'overworld', { x: -30000000, y: -64, z: -30000000 }).bounds.maxX, 30000000);
});

test('header rejects unvalidated versions, dimensions, coordinates, air modes and build heights', () => {
  const anchor = { x: 0, y: 0, z: 0 };
  for (const [side, property, value] of [['source', 'version', '26.3'], ['source', 'version', '26.2.1'], ['source', 'dataVersion', 5023], ['destination', 'version', '26.3'], ['destination', 'dataVersion', 5023]]) {
    const h = header(), w = world(); (side === 'source' ? h.source : w.metadata)[property] = value;
    assert.throws(() => validateTemplatePlacementHeader(h, w, 'overworld', anchor), { code: 'PLACEMENT_VERSION' });
  }
  const h = header(); h.source.dimensionId = 'minecraft:the_nether';
  assert.throws(() => validateTemplatePlacementHeader(h, world(), 'overworld', anchor), { code: 'PLACEMENT_DIMENSION' });
  const custom = world(); custom.dimensions[0].id = 'custom:world'; h.source.dimensionId = 'custom:world';
  assert.throws(() => validateTemplatePlacementHeader(h, custom, 'overworld', anchor), { code: 'PLACEMENT_DIMENSION' });
  assert.throws(() => validateTemplatePlacementHeader(header(), world(), 'overworld', { ...anchor, x: 0.5 }), { code: 'TRANSFER_ANCHOR' });
  assert.throws(() => validateTemplatePlacementHeader(header(), world(), 'overworld', { ...anchor, x: 30000000 }), { code: 'PLACEMENT_BOUNDS' });
  assert.throws(() => validateTemplatePlacementHeader(header(), world(), 'overworld', { ...anchor, y: 319 }), { code: 'PLACEMENT_HEIGHT' });
  assert.throws(() => validateTemplatePlacementHeader(header(), world(), 'overworld', anchor, { airMode: 'invent-air' }), { code: 'TRANSFER_AIR_MODE' });
});

test('source emits exact selected air and block properties; excluded blocks and metadata remain untouched', () => {
  const selected = [[0, 0, 0], [2, 0, 0]], chunk = source({ cells: selected, block: x => state(x === 0 ? 'cave_air' : x === 2 ? 'oak_stairs' : 'chest', x === 2 ? { facing: 'west', half: 'top', shape: 'outer_left', waterlogged: 'false' } : undefined),
    extra: { block_entities: list([{ ...coordinates(1), id: [8, 'minecraft:chest'], Items: list([]) }]), unknown: [4, 9007199254740993n] },
    entities: entityRaw([entity(1.9)]), poi: poiRaw([{ pos: [4, packedPos(1, 0, 0)] }]) });
  const copies = Object.fromEntries(Object.entries(chunk.records).map(([k, v]) => [k, Buffer.from(v)]));
  const view = validateTemplateSourceChunk(chunk), cells = [...view.blocks()];
  assert.deepEqual(cells.map(c => c.x), [0, 2]); assert.deepEqual(cells[0].state, state('cave_air'));
  assert.deepEqual(cells[1].state, state('oak_stairs', { facing: 'west', half: 'top', shape: 'outer_left', waterlogged: 'false' }));
  assert.equal(view.contains(0, 0, 0), true); assert.equal(view.contains(1, 0, 0), false); assert.equal(view.contains(16, 0, 0), false);
  for (const k of Object.keys(copies)) assert.deepEqual(chunk.records[k], copies[k]);
  chunk.sections[0].mask.fill(255); assert.deepEqual([...view.blocks()].map(c => c.x), [0, 2], 'Validated masks are snapshots.');
});

test('source denies selected special blocks, fluids, waterlogging and unknown terrain', () => {
  for (const block of [state('chest'), state('water'), state('structure_void'), state('nether_portal'), state('redstone_wire'), state('new_unknown_block'), state('oak_stairs', { waterlogged: 'true' })])
    assert.throws(() => validateTemplateSourceChunk(source({ block: () => block })), { code: 'PLACEMENT_SOURCE_BLOCK' });
  assert.throws(() => validateTemplateSourceChunk(source({ cells: [[0, 16, 0]] })), { code: 'PLACEMENT_UNKNOWN' });
  const missing = source(); missing.records.region = null;
  assert.throws(() => validateTemplateSourceChunk(missing), { code: 'PLACEMENT_UNKNOWN' });
});

test('source denies each selected attachment including passenger and hanging entity anchors', () => {
  for (const field of ['block_entities', 'block_ticks', 'fluid_ticks'])
    assert.throws(() => validateTemplateSourceChunk(source({ extra: { [field]: list([coordinates()]) } })), { code: 'PLACEMENT_SOURCE_ATTACHMENTS' });
  for (const e of [entity(0.9, 0.1, 0.2), entity(2, 0, 0, { TileX: [3, 0], TileY: [3, 0], TileZ: [3, 0] }), entity(2, 0, 0, { Passengers: list([entity(0.5)]) })])
    assert.throws(() => validateTemplateSourceChunk(source({ entities: entityRaw([e]) })), { code: 'PLACEMENT_SOURCE_ATTACHMENTS' });
  assert.throws(() => validateTemplateSourceChunk(source({ poi: poiRaw([{ pos: [4, packedPos(0, 0, 0)] }]) })), { code: 'PLACEMENT_SOURCE_ATTACHMENTS' });
});

test('source fails closed on cross-chunk attachments rather than guessing another frame selection', () => {
  for (const field of ['block_entities', 'block_ticks', 'fluid_ticks'])
    assert.throws(() => validateTemplateSourceChunk(source({ extra: { [field]: list([coordinates(16)]) } })), { code: 'PLACEMENT_SOURCE_CROSS_CHUNK' });
  for (const e of [entity(16), entity(2, 0, 0, { TileX: [3, 16], TileY: [3, 0], TileZ: [3, 0] }), entity(2, 0, 0, { Passengers: list([entity(16)]) })])
    assert.throws(() => validateTemplateSourceChunk(source({ entities: entityRaw([e]) })), { code: 'PLACEMENT_SOURCE_CROSS_CHUNK' });
  assert.throws(() => validateTemplateSourceChunk(source({ poi: poiRaw([{ pos: [4, packedPos(16, 0, 0)] }]) })), { code: 'PLACEMENT_SOURCE_CROSS_CHUNK' });
});

test('destination checks selected attachment occupancy including neighbor records and excluded cells', () => {
  for (const field of ['block_entities', 'block_ticks', 'fluid_ticks']) {
    const view = destination({ extra: { [field]: list([coordinates(1)]) } });
    assert.deepEqual(assertDestinationCellWritable(view, 0, 0, 0), state('stone'));
    assert.throws(() => assertDestinationCellWritable(view, 1, 0, 0), { code: 'PLACEMENT_DESTINATION_ATTACHMENTS' });
    assertDestinationAttachmentsClear(view, x => x === 0);
    assert.throws(() => assertDestinationAttachmentsClear(view, x => x === 1), { code: 'PLACEMENT_DESTINATION_ATTACHMENTS' });
  }
  const view = destination({ x: 1, entities: entityRaw([entity(18, 0, 0, { Passengers: list([entity(0.4)]) }), entity(18, 0, 0, { TileX: [3, 1], TileY: [3, 0], TileZ: [3, 0] })], 1), poi: poiRaw([{ pos: [4, packedPos(2, 0, 0)] }]) });
  for (const x of [0, 1, 2]) assert.throws(() => assertDestinationAttachmentsClear(view, (px, py, pz) => px === x && py === 0 && pz === 0), { code: 'PLACEMENT_DESTINATION_ATTACHMENTS' });
  assertDestinationAttachmentsClear(view, x => x === 3);
});

test('negative coordinate masks, entity floor positions and signed packed POI positions match exact cells', () => {
  const view = validateTemplateSourceChunk(source({ x: -1, z: -1, sections: [-1], cells: [[-1, -1, -1]], block: () => state('void_air') }));
  assert.equal(view.contains(-1, -1, -1), true); assert.equal(view.contains(-2, -1, -1), false);
  assert.deepEqual([...view.blocks()], [{ x: -1, y: -1, z: -1, state: state('void_air') }]);
  for (const options of [{ entities: entityRaw([entity(-0.1, -0.1, -0.1)], -1, -1) }, { poi: poiRaw([{ pos: [4, packedPos(-1, -1, -1)] }]) }]) {
    const target = destination({ x: -1, z: -1, sections: [-1], ...options });
    assert.throws(() => assertDestinationCellWritable(target, -1, -1, -1), { code: 'PLACEMENT_DESTINATION_ATTACHMENTS' });
    assert.deepEqual(assertDestinationCellWritable(target, -2, -1, -1), state('stone'));
  }
});

test('destination requires complete known versioned terrain and rejects pending upgrade/update data', () => {
  for (const field of ['UpgradeData', 'below_zero_retrogen', 'blending_data'])
    assert.throws(() => destination({ extra: { [field]: [10, {}] } }), { code: 'PLACEMENT_UPGRADE' });
  for (const post of [[9, { type: 9, values: [{ type: 2, values: [1] }] }], [8, 'malformed']])
    assert.throws(() => destination({ extra: { PostProcessing: post } }), { code: 'PLACEMENT_UPDATES' });
  destination({ extra: { PostProcessing: [9, { type: 9, values: [{ type: 2, values: [] }] }] } });
  assert.throws(() => destination({ extra: { Status: [8, 'minecraft:noise'] } }), { code: 'PLACEMENT_UNKNOWN' });
  assert.throws(() => destination({ extra: { DataVersion: [3, 5023] } }), { code: 'PLACEMENT_VERSION' });
  assert.throws(() => destination({ entities: entityRaw([], 0, 0, { DataVersion: [3, 5023] }) }), { code: 'PLACEMENT_VERSION' });
  assert.throws(() => destination({ poi: poiRaw([], { DataVersion: [3, 5023] }) }), { code: 'PLACEMENT_VERSION' });
  validateTemplateDestinationChunk(nbt(regionTags()), null, nbt({ Sections: [10, {}] }), 0, 0);
  assert.throws(() => assertDestinationCellWritable(destination(), 0, 16, 0), { code: 'PLACEMENT_UNKNOWN' });
  assert.throws(() => assertDestinationCellWritable(destination(), 16, 0, 0), { code: 'PLACEMENT_COORDINATES' });
});

test('raw evidence is independently validated and malformed metadata never disappears into exclusions', () => {
  for (const validator of [options => validateTemplateSourceChunk(source(options)), destination]) {
    assert.throws(() => validator({ sections: [0, 0] }), { code: 'PLACEMENT_SECTIONS' });
    assert.throws(() => validator({ extra: { block_entities: list([{ x: [3, 2] }]) } }), { code: 'PLACEMENT_METADATA' });
    assert.throws(() => validator({ entities: entityRaw([{ id: [8, 'minecraft:pig'] }]) }), { code: 'PLACEMENT_ENTITIES' });
    assert.throws(() => validator({ entities: entityRaw([], 1) }), { code: 'PLACEMENT_ENTITIES' });
    assert.throws(() => validator({ entities: entityRaw([entity(2, 0, 0, { TileX: [3, 2] })]) }), { code: 'PLACEMENT_ENTITIES' });
    assert.throws(() => validator({ poi: nbt({ Sections: [8, 'malformed'] }) }), { code: 'PLACEMENT_POI' });
    for (const bad of [{}, { pos: [3, 0] }, { pos: [8, 'not-a-long'] }, { pos: [8, '9223372036854775808'] }])
      assert.throws(() => validator({ poi: poiRaw([bad]) }), { code: 'PLACEMENT_POI' });
  }
  const raw = nbt(regionTags({ extra: { DataVersion: [3, 5023] } }));
  assert.throws(() => validateTemplateDestinationChunk({ raw, nbt: { DataVersion: 4903 } }, null, null, 0, 0), { code: 'PLACEMENT_VERSION' });
  const chunk = source(); chunk.sections[0].mask = Buffer.alloc(511);
  assert.throws(() => validateTemplateSourceChunk(chunk), { code: 'PLACEMENT_MASK' });
});

test('source checking honors cancellation before and during section iteration', () => {
  const cancelled = new AbortController(); cancelled.abort();
  assert.throws(() => validateTemplateSourceChunk(source(), { signal: cancelled.signal }), { code: 'TEMPLATE_CANCELLED' });
  let checks = 0;
  assert.throws(() => validateTemplateSourceChunk(source({ sections: [0, 1], cells: [[0, 0, 0], [0, 16, 0]] }), { shouldCancel: () => ++checks >= 3 }), { code: 'TEMPLATE_CANCELLED' });
});
