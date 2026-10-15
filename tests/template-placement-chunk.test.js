import test from 'node:test';
import assert from 'node:assert/strict';
import { rewriteTemplateChunk } from '../engine/template-placement-chunk.js';
import { decodeSection, stateKey } from '../engine/chunks.js';
import { compound, field, plain, readTypedNBT, removeField, setField, tag, writeTypedNBT } from '../engine/typed-nbt.js';
import { nbt } from './fixtures.js';
import { sectionFixture, state } from './transfer-fixtures.js';

const zero = { x: 0, y: 0, z: 0 };
const mod16 = n => (n % 16 + 16) % 16;
const nodeBytes = node => writeTypedNBT(compound({ value: node }));
function chunkRaw({ x = 0, z = 0, ys = [0], block = () => state('stone'), tags = {}, sectionTags = {} } = {}) {
  return nbt({
    DataVersion: [3, 4903], xPos: [3, x], zPos: [3, z], Status: [8, 'minecraft:full'],
    sections: [9, { type: 10, values: ys.map(y => ({ ...sectionFixture(y, block),
      BlockLight: [7, Buffer.alloc(2048, 0x3a)], SkyLight: [7, Buffer.alloc(2048, 0x5b)],
      futureSection: [10, { opaque: [7, Buffer.from([0, 99, 255])] }], ...sectionTags })) }],
    block_entities: [9, { type: 10, values: [] }], block_ticks: [9, { type: 10, values: [] }], fluid_ticks: [9, { type: 10, values: [] }],
    Heightmaps: [10, { WORLD_SURFACE: [12, [9223372036854775807n]] }], isLightOn: [1, 1],
    futureChunk: [10, { long: [4, -9223372036854775807n], opaque: [7, Buffer.from([1, 0, 255])] }], ...tags
  });
}
function edited(raw, edit) { const root = readTypedNBT(raw); edit(root); return writeTypedNBT(root); }
function masks(points) {
  const map = new Map();
  for (const [x, y, z] of points) {
    const sy = Math.floor(y / 16), at = mod16(y) * 256 + mod16(z) * 16 + mod16(x);
    if (!map.has(sy)) map.set(sy, Buffer.alloc(512));
    map.get(sy)[at >> 3] |= 1 << (at & 7);
  }
  return [...map].map(([y, mask]) => ({ y, mask }));
}
function patch(raw, points = [[0, 0, 0]], offset = zero) {
  const root = plain(readTypedNBT(raw));
  return { chunk: { x: root.xPos, z: root.zPos, sections: masks(points), records: { region: raw } }, offset };
}
function decoded(raw) {
  return new Map(plain(readTypedNBT(raw)).sections.filter(section => section.block_states).map(section => [section.Y, decodeSection(section)]));
}
function blockAt(sections, x, y, z) {
  const section = sections.get(Math.floor(y / 16)), at = mod16(y) * 256 + mod16(z) * 16 + mod16(x);
  return section.palette[section.indices[at]];
}
function assertBlocks(raw, expected, ys = [0]) {
  const result = decoded(raw);
  for (const sy of ys) for (let ly = 0; ly < 16; ly++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    const y = sy * 16 + ly;
    assert.equal(stateKey(blockAt(result, x, y, z)), stateKey(expected(x, y, z)), `block ${x},${y},${z}`);
  }
}

test('four source chunks translate sparse disconnected cells across negative chunk and section boundaries', () => {
  const stair = state('oak_stairs', { facing: 'west', half: 'top', shape: 'outer_left', waterlogged: 'false' });
  const entries = [
    { x: -1, z: -1, point: [-1, -1, -1], state: state('glass') },
    { x: 0, z: -1, point: [0, 14, -1], state: stair },
    { x: -1, z: 0, point: [-1, 14, 0], state: state('cave_air') },
    { x: 0, z: 0, point: [0, -1, 0], state: state('quartz_block') }
  ];
  const offset = { x: 1, y: 3, z: 1 }, expected = new Map();
  const patches = entries.map(entry => {
    const raw = chunkRaw({ x: entry.x, z: entry.z, ys: [-1, 0], block: () => entry.state });
    const [x, y, z] = entry.point; expected.set(`${x + 1},${y + 3},${z + 1}`, entry.state);
    return patch(raw, [entry.point], offset);
  });
  const destination = chunkRaw({ ys: [1, 0] }), original = Buffer.from(destination);
  const output = rewriteTemplateChunk(destination, 0, 0, patches);
  assert.equal(output.changedBlocks, 4); assert.equal(output.changed, true); assert.deepEqual(destination, original);
  assertBlocks(output.raw, (x, y, z) => expected.get(`${x},${y},${z}`) ?? state('stone'), [0, 1]);
  assert.deepEqual(plain(readTypedNBT(output.raw)).sections.map(section => section.Y), [1, 0]);
});

test('include and skip honor exact air variants and leave every excluded cell untouched', () => {
  const values = ['air', 'cave_air', 'void_air', 'glass'];
  const source = chunkRaw({ block: x => state(values[x % 4]) }), destination = chunkRaw();
  const selected = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]];
  for (const airMode of ['include', 'skip']) {
    const output = rewriteTemplateChunk(destination, 0, 0, [patch(source, selected)], { airMode });
    assert.equal(output.changedBlocks, airMode === 'include' ? 4 : 1);
    assertBlocks(output.raw, (x, y, z) => y === 0 && z === 0 && x < 4 && (airMode === 'include' || x === 3) ? state(values[x]) : state('stone'));
  }
});

test('retains typed player/container metadata, unknown payloads, unused palette entries and untouched palettes', () => {
  const inventory = { id: [8, 'minecraft:chest'], x: [3, 15], y: [3, 15], z: [3, 15],
    Items: [9, { type: 10, values: [{ Slot: [1, 4], count: [3, 64], id: [8, 'minecraft:diamond'],
      components: [10, { future: [7, Buffer.from([0, 1, 255])], long: [4, 9223372036854775807n] }] }] }],
    futureContainer: [12, [-9223372036854775807n, 9223372036854775807n]] };
  let destination = chunkRaw({ ys: [0, 1], block: (x, y, z) => x === 15 && y === 15 && z === 15 ? state('chest') : state('stone'),
    tags: { block_entities: [9, { type: 10, values: [inventory] }], Player: [10, { Inventory: inventory.Items, Health: [5, 19.5], unknown: [4, 9223372036854775807n] }], unknownFloat: [5, NaN] } });
  destination = edited(destination, root => {
    field(root, 'unknownFloat').raw = Buffer.from([0x7f, 0xc0, 0, 1]);
    const palette = field(field(field(root, 'sections').value[0], 'block_states'), 'palette');
    setField(palette.value[1], 'futurePalette', compound({ opaque: tag(7, Buffer.from([7, 0, 255])) }));
    palette.value.push(compound({ Name: tag(8, 'unknown:unused'), future: tag(12, ['9223372036854775807']) }));
  });
  const before = readTypedNBT(destination), source = chunkRaw({ block: () => state('glass') });
  const output = rewriteTemplateChunk(destination, 0, 0, [patch(source)]), after = readTypedNBT(output.raw);
  assertBlocks(output.raw, (x, y, z) => x === 0 && y === 0 && z === 0 ? state('glass') : x === 15 && y === 15 && z === 15 ? state('chest') : state('stone'), [0, 1]);
  for (const name of ['Player', 'block_entities', 'block_ticks', 'fluid_ticks', 'futureChunk', 'unknownFloat']) {
    assert.deepEqual(nodeBytes(field(after, name)), nodeBytes(field(before, name)), name);
  }
  const oldSections = field(before, 'sections').value, newSections = field(after, 'sections').value;
  for (let i = 0; i < oldSections.length; i++) assert.deepEqual(nodeBytes(field(oldSections[i], 'futureSection')), nodeBytes(field(newSections[i], 'futureSection')));
  const beforePalette = field(field(oldSections[0], 'block_states'), 'palette'), afterPalette = field(field(newSections[0], 'block_states'), 'palette');
  assert.equal(afterPalette.value.length, beforePalette.value.length + 1);
  beforePalette.value.forEach((value, i) => assert.deepEqual(nodeBytes(value), nodeBytes(afterPalette.value[i])));
  assert.deepEqual(nodeBytes(field(oldSections[1], 'block_states')), nodeBytes(field(newSections[1], 'block_states')));
  assert.equal(field(after, 'Heightmaps'), undefined);
});

test('lighting-only preparation retains heightmaps, all blocks and unrelated typed metadata', () => {
  const destination = chunkRaw(), before = readTypedNBT(destination);
  for (const patches of [[], [patch(chunkRaw())], [patch(chunkRaw({ block: () => state('air') }))]]) {
    const output = rewriteTemplateChunk(destination, 0, 0, patches, { airMode: 'skip' }), after = readTypedNBT(output.raw);
    assert.equal(output.changed, false); assert.equal(output.changedBlocks, 0);
    assert.deepEqual(nodeBytes(field(before, 'Heightmaps')), nodeBytes(field(after, 'Heightmaps')));
    assert.deepEqual(nodeBytes(field(field(before, 'sections').value[0], 'block_states')), nodeBytes(field(field(after, 'sections').value[0], 'block_states')));
    assert.equal(plain(field(after, 'isLightOn')), 0);
    for (const section of field(after, 'sections').value) { assert.equal(field(section, 'BlockLight'), undefined); assert.equal(field(section, 'SkyLight'), undefined); }
  }
});

test('missing source or destination terrain remains unknown even when source air is skipped', () => {
  const source = chunkRaw({ block: () => state('air') }), destination = chunkRaw();
  assert.throws(() => rewriteTemplateChunk(destination, 0, 0, [patch(source, [[0, 16, 0]])]), { code: 'PLACEMENT_UNKNOWN' });
  assert.throws(() => rewriteTemplateChunk(chunkRaw({ ys: [] }), 0, 0, [patch(source)], { airMode: 'skip' }), { code: 'PLACEMENT_UNKNOWN' });
  for (const which of ['source', 'destination']) {
    const bad = edited(which === 'source' ? source : destination, root => removeField(field(root, 'sections').value[0], 'block_states'));
    assert.throws(() => rewriteTemplateChunk(which === 'destination' ? bad : destination, 0, 0, [patch(which === 'source' ? bad : source)], { airMode: 'skip' }), { code: 'PLACEMENT_UNKNOWN' });
  }
});

test('source special/unknown blocks and replaced destination special blocks remain unsupported', () => {
  for (const name of ['chest', 'nether_portal', 'redstone_wire', 'water', 'structure_void', 'unknown:block']) {
    const special = chunkRaw({ block: () => ({ Name: name.includes(':') ? name : `minecraft:${name}` }) });
    assert.throws(() => rewriteTemplateChunk(chunkRaw(), 0, 0, [patch(special)], { airMode: 'skip' }), { code: 'PLACEMENT_STATE' }, name);
    assert.throws(() => rewriteTemplateChunk(special, 0, 0, [patch(chunkRaw())]), { code: 'PLACEMENT_STATE' }, name);
  }
  const wet = chunkRaw({ block: () => state('oak_stairs', { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: 'true' }) });
  assert.throws(() => rewriteTemplateChunk(chunkRaw(), 0, 0, [patch(wet)]), { code: 'PLACEMENT_STATE' });
});

test('selected source extensions and replaced destination extensions fail closed', () => {
  const ordinary = chunkRaw(), glass = chunkRaw({ block: () => state('glass') });
  const extended = edited(ordinary, root => setField(field(field(field(root, 'sections').value[0], 'block_states'), 'palette').value[0], 'future', tag(7, Buffer.from([1]))));
  assert.throws(() => rewriteTemplateChunk(glass, 0, 0, [patch(extended)]), { code: 'PLACEMENT_STATE' });
  assert.throws(() => rewriteTemplateChunk(extended, 0, 0, [patch(glass)]), { code: 'PLACEMENT_STATE' });
  const storage = edited(ordinary, root => setField(field(field(root, 'sections').value[0], 'block_states'), 'futureStorage', tag(12, ['1'])));
  assert.throws(() => rewriteTemplateChunk(glass, 0, 0, [patch(storage)]), { code: 'PLACEMENT_UNKNOWN' });
  assert.throws(() => rewriteTemplateChunk(storage, 0, 0, [patch(glass)]), { code: 'PLACEMENT_STATE' });
  assert.deepEqual(nodeBytes(field(field(readTypedNBT(rewriteTemplateChunk(storage, 0, 0, []).raw), 'sections').value[0], 'block_states')),
    nodeBytes(field(field(readTypedNBT(storage), 'sections').value[0], 'block_states')));
});

test('compact/current palette read support does not widen the placement writer format', () => {
  const ordinary = chunkRaw();
  for (const modern of [true, false]) {
    const source = edited(ordinary, root => {
      const states = field(field(root, 'sections').value[0], 'block_states');
      setField(states, 'palette', modern ? tag(9, [compound({ id: tag(8, 'minecraft:stone') })], 10) : tag(9, [tag(8, 'minecraft:stone')], 8));
    });
    assert.throws(() => rewriteTemplateChunk(ordinary, 0, 0, [patch(source)]), { code: modern ? 'PLACEMENT_STATE' : 'PLACEMENT_SCHEMA' });
  }
  const mixed = edited(chunkRaw({ block: x => state(x ? 'stone' : 'glass') }), root => {
    const palette = field(field(field(root, 'sections').value[0], 'block_states'), 'palette');
    palette.value[0] = compound({ id: tag(8, 'minecraft:glass') });
  });
  assert.throws(() => rewriteTemplateChunk(mixed, 0, 0, [patch(chunkRaw({ block: () => state('oak_planks') }), [[1, 0, 0]])]), { code: 'PLACEMENT_STATE' });
});

test('touching block entities or ticks blocks even if selected air is skipped or state is unchanged', () => {
  for (const name of ['block_entities', 'block_ticks', 'fluid_ticks']) {
    const tags = { [name]: [9, { type: 10, values: [{ x: [3, 0], y: [3, 0], z: [3, 0], unknown: [4, 9n] }] }] };
    const marked = chunkRaw({ tags });
    assert.throws(() => rewriteTemplateChunk(chunkRaw(), 0, 0, [patch(marked)]), { code: 'PLACEMENT_ATTACHMENTS' });
    assert.throws(() => rewriteTemplateChunk(marked, 0, 0, [patch(chunkRaw({ block: () => state('air') }))], { airMode: 'skip' }), { code: 'PLACEMENT_ATTACHMENTS' });
    const unrelated = rewriteTemplateChunk(marked, 0, 0, [patch(chunkRaw({ block: () => state('glass') }), [[1, 0, 0]])]);
    assert.deepEqual(nodeBytes(field(readTypedNBT(unrelated.raw), name)), nodeBytes(field(readTypedNBT(marked), name)));
  }
});

test('strict terrain metadata gates reject wrong versions, mismatched chunks, duplicate sections and pending updates', () => {
  const ordinary = chunkRaw();
  const invalid = [
    [root => setField(root, 'DataVersion', tag(3, 5023)), 'PLACEMENT_VERSION'],
    [root => setField(root, 'xPos', tag(3, 1)), 'PLACEMENT_POSITION'],
    [root => setField(root, 'Status', tag(8, 'minecraft:noise')), 'PLACEMENT_SCHEMA'],
    [root => field(root, 'sections').value.push(field(root, 'sections').value[0]), 'PLACEMENT_SECTIONS'],
    [root => removeField(root, 'block_entities'), 'PLACEMENT_METADATA'],
    [root => setField(root, 'block_ticks', tag(9, [compound({ x: tag(3, 0) })], 10)), 'PLACEMENT_METADATA'],
    [root => setField(root, 'UpgradeData', compound({})), 'PLACEMENT_UPGRADE'],
    [root => setField(root, 'blending_data', compound({})), 'PLACEMENT_UPGRADE'],
    [root => setField(root, 'below_zero_retrogen', compound({})), 'PLACEMENT_UPGRADE'],
    [root => setField(root, 'PostProcessing', tag(9, [tag(9, [tag(2, 1)], 2)], 9)), 'PLACEMENT_UPDATES']
  ];
  for (const [edit, code] of invalid) {
    const raw = edited(ordinary, edit);
    assert.throws(() => rewriteTemplateChunk(raw, 0, 0, []), { code });
  }
  assert.throws(() => rewriteTemplateChunk(ordinary.subarray(0, ordinary.length - 1), 0, 0, []), { code: 'NBT_TRUNCATED' });
});

test('malformed masks, duplicate patches, inconsistent transforms and imprecise translations are rejected', () => {
  const ordinary = chunkRaw(), valid = patch(ordinary);
  assert.throws(() => rewriteTemplateChunk(ordinary, 0, 0, [valid], { airMode: 'maybe' }), { code: 'TRANSFER_AIR_MODE' });
  assert.throws(() => rewriteTemplateChunk(ordinary, 0, 0, [valid, valid]), { code: 'PLACEMENT_PATCH' });
  assert.throws(() => rewriteTemplateChunk(ordinary, 0, 0, [valid, patch(chunkRaw({ x: 1 }), [[16, 0, 0]], { x: -1, y: 0, z: 0 })]), { code: 'PLACEMENT_PATCH' });
  assert.throws(() => rewriteTemplateChunk(ordinary, 0, 0, [patch(ordinary, [[0, 0, 0]], { x: 0.5, y: 0, z: 0 })]), { code: 'PLACEMENT_PATCH' });
  assert.throws(() => rewriteTemplateChunk(ordinary, 0, 0, [patch(ordinary, [[1, 0, 0]], { x: Number.MAX_SAFE_INTEGER, y: 0, z: 0 })]), { code: 'PLACEMENT_POSITION' });
  for (const sections of [[{ y: 0, mask: Buffer.alloc(511) }], [valid.chunk.sections[0], valid.chunk.sections[0]], [{ y: NaN, mask: Buffer.alloc(512) }]]) {
    assert.throws(() => rewriteTemplateChunk(ordinary, 0, 0, [{ ...valid, chunk: { ...valid.chunk, sections } }]), { code: 'PLACEMENT_MASK' });
  }
  const five = Array.from({ length: 5 }, (_, x) => patch(chunkRaw({ x }), [[x * 16, 0, 0]]));
  assert.throws(() => rewriteTemplateChunk(ordinary, 0, 0, five), { code: 'PLACEMENT_PATCH' });
});

test('packing expands past a 16-state palette without changing any original palette entry or excluded block', () => {
  const names = ['stone', 'granite', 'diorite', 'andesite', 'dirt', 'coarse_dirt', 'cobblestone', 'bricks', 'obsidian',
    'netherrack', 'end_stone', 'quartz_block', 'sandstone', 'terracotta', 'tuff', 'calcite'];
  const destination = chunkRaw({ block: x => state(names[x]) });
  const output = rewriteTemplateChunk(destination, 0, 0, [patch(chunkRaw({ block: () => state('glass') }))]);
  assertBlocks(output.raw, (x, y, z) => x === 0 && y === 0 && z === 0 ? state('glass') : state(names[x]));
  const section = plain(readTypedNBT(output.raw)).sections[0];
  assert.equal(section.block_states.palette.length, 17); assert.equal(section.block_states.data.length, Math.ceil(4096 / 12));
});

test('a full retained palette fails rather than discarding unused entries to make room', () => {
  const destination = edited(chunkRaw(), root => {
    const states = field(field(root, 'sections').value[0], 'block_states');
    setField(states, 'palette', tag(9, Array.from({ length: 4096 }, () => compound({ Name: tag(8, 'minecraft:stone') })), 10));
    setField(states, 'data', tag(12, Array(Math.ceil(4096 / 5)).fill('0')));
  });
  assert.throws(() => rewriteTemplateChunk(destination, 0, 0, [patch(chunkRaw({ block: () => state('glass') }))]), { code: 'PLACEMENT_PALETTE' });
});

test('24 full sections are processed with a single-use patch iterator and exact cell verification', () => {
  const ys = Array.from({ length: 24 }, (_, i) => i - 4), source = chunkRaw({ ys, block: () => state('glass') }), destination = chunkRaw({ ys });
  const fullPatch = { chunk: { x: 0, z: 0, sections: ys.map(y => ({ y, mask: Buffer.alloc(512, 255) })), records: { region: source } }, offset: zero };
  let consumed = 0, closed = false;
  function* once() { try { consumed++; yield fullPatch; } finally { closed = true; } }
  const output = rewriteTemplateChunk(destination, 0, 0, once());
  assert.equal(consumed, 1); assert.equal(closed, true); assert.equal(output.changedBlocks, 24 * 4096);
  const sections = decoded(output.raw);
  for (const section of sections.values()) assert.ok(section.indices.every(id => stateKey(section.palette[id]) === stateKey(state('glass'))));
});

test('cancellation closes the iterator and leaves all caller buffers unchanged', () => {
  const source = chunkRaw({ block: () => state('glass') }), destination = chunkRaw(), oldSource = Buffer.from(source), oldDestination = Buffer.from(destination);
  const fullPatch = { chunk: { x: 0, z: 0, sections: [{ y: 0, mask: Buffer.alloc(512, 255) }], records: { region: source } }, offset: zero };
  let checks = 0, closed = false;
  function* once() { try { yield fullPatch; } finally { closed = true; } }
  assert.throws(() => rewriteTemplateChunk(destination, 0, 0, once(), { shouldCancel: () => ++checks === 10 }), { code: 'TEMPLATE_CANCELLED' });
  assert.equal(closed, true); assert.deepEqual(source, oldSource); assert.deepEqual(destination, oldDestination);
  assert.throws(() => rewriteTemplateChunk(destination, 0, 0, [], { signal: AbortSignal.abort() }), { code: 'TEMPLATE_CANCELLED' });
});
