import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeSection } from '../engine/chunks.js';

const decode = palette => decodeSection({ Y: -4, block_states: { palette } });
for (const [label, state] of Object.entries({
  legacy: { Name: 'minecraft:oak_stairs', Properties: { facing: 'north', half: 'bottom', waterlogged: 'true' } },
  modern: { id: 'minecraft:oak_stairs', properties: { facing: 'north', half: 'bottom', waterlogged: 'true' } }
})) test(`${label} palette preserves state properties, normalizes output and leaves input untouched`, () => {
  const before = structuredClone(state), result = decode([state]);
  assert.deepEqual(result.palette, [{ Name: 'minecraft:oak_stairs', Properties: { facing: 'north', half: 'bottom', waterlogged: 'true' } }]);
  assert.deepEqual(state, before); assert.equal(result.y, -4); assert.equal(result.indices.length, 4096);
  assert.ok(result.indices.every(n => n === 0));
});
test('compact default states decode without inventing properties', () => {
  assert.deepEqual(decode(['minecraft:stone']).palette, [{ Name: 'minecraft:stone' }]);
});
test('packed modern palette indices cross a 64-bit word boundary correctly', () => {
  // Independent explicit 4-bit test vector: index 15 at end of word 0, index 16 at start of word 1.
  const data = Array(256).fill('0'); data[0] = '-9223372036854775808'; data[1] = '1';
  const palette = Array.from({ length: 9 }, (_, i) => ({ id: `minecraft:fixture_${i}` }));
  const result = decodeSection({ Y: 4, block_states: { palette, data } });
  assert.equal(result.indices[14], 0); assert.equal(result.indices[15], 8); assert.equal(result.indices[16], 1); assert.equal(result.indices[17], 0);
});
for (const state of [
  { Name: 'minecraft:stone', id: 'minecraft:air' },
  { Name: 'minecraft:stone', id: 'minecraft:stone' },
  { Name: 'minecraft:stone', properties: {} }, { id: 'minecraft:stone', Properties: {} },
  { id: 'minecraft:stone', properties: { waterlogged: true } },
  { id: 'minecraft:stone', properties: [] }, { id: 'minecraft:stone', properties: null },
  { id: 'STONE' }, { id: '../stone' }, { id: '' }, {}, null, [], 42
]) test(`malformed or ambiguous palette state fails closed: ${JSON.stringify(state)}`, () => {
  assert.throws(() => decode([state]), { code: 'BLOCK_STATE' });
});
