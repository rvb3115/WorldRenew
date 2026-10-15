import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeSection } from '../engine/chunks.js';

function sectionFor(bits, count = 2 ** bits) {
  const palette = Array.from({ length: count }, (_, i) => ({ Name: `example:block_${i}` })), perWord = Math.floor(64 / bits);
  const ids = Array.from({ length: 4096 }, (_, i) => i % 17 === 0 ? count - 1 : ((i * 1987) ^ (i >>> 3)) % count), data = [];
  for (let start = 0; start < ids.length; start += perWord) {
    let word = 0n;
    const used = Math.min(perWord, ids.length - start);
    for (let slot = 0; slot < used; slot++) word |= BigInt(ids[start + slot]) << BigInt(bits * slot);
    // Set ignored high padding and last-word unused slots to ones. This makes
    // signed negative words common without introducing a real palette index.
    const usedBits = used * bits;
    if (usedBits < 64) word |= ((1n << BigInt(64 - usedBits)) - 1n) << BigInt(usedBits);
    data.push(BigInt.asIntN(64, word).toString());
  }
  return { section: { Y: -4, block_states: { palette, data } }, ids, bits, perWord };
}
function reference(section) {
  const count = section.block_states.palette.length, bits = Math.max(4, Math.ceil(Math.log2(count))), perWord = Math.floor(64 / bits), mask = (1n << BigInt(bits)) - 1n;
  const words = section.block_states.data.map(v => BigInt.asUintN(64, BigInt(v)));
  return Uint16Array.from({ length: 4096 }, (_, i) => Number((words[Math.floor(i / perWord)] >> BigInt((i % perWord) * bits)) & mask));
}

for (let bits = 4; bits <= 12; bits++) test(`exact ${bits}-bit extraction matches BigInt across uint32 boundaries and padded negative longs`, () => {
  for (const count of [2 ** bits, 2 ** (bits - 1) + 1]) {
    const { section, ids } = sectionFor(bits, count), before = structuredClone(section), result = decodeSection(section);
    assert.deepEqual([...result.indices], ids); assert.deepEqual(result.indices, reference(section));
    assert.deepEqual(section, before); assert.ok(section.block_states.data.some(v => v.startsWith('-')));
  }
});

test('out-of-range palette indices remain errors at straddling and final valid slots', () => {
  for (let bits = 4; bits <= 12; bits++) {
    const count = 2 ** (bits - 1) + 1, fixture = sectionFor(bits, count), mask = (1n << BigInt(bits)) - 1n;
    const straddles = Array.from({ length: fixture.perWord }, (_, i) => i).filter(i => i * bits < 32 && (i + 1) * bits > 32);
    for (const at of [0, ...straddles, 4095]) {
      const section = structuredClone(fixture.section), word = Math.floor(at / fixture.perWord), shift = BigInt((at % fixture.perWord) * bits);
      const value = BigInt.asUintN(64, BigInt(section.block_states.data[word]));
      section.block_states.data[word] = BigInt.asIntN(64, (value & ~(mask << shift)) | (BigInt(count) << shift)).toString();
      assert.throws(() => decodeSection(section), { code: 'BLOCK_INDEX' });
    }
  }
});

test('all signed-long types, ranges and counts are validated before index extraction', () => {
  for (const value of ['9223372036854775808', '-9223372036854775809', '1.0', '0x1', '1e3', '', 0, 0n, null, undefined]) {
    const { section } = sectionFor(4, 9); section.block_states.data[0] = '15'; section.block_states.data[255] = value;
    assert.throws(() => decodeSection(section), { code: 'BLOCK_DATA' });
  }
  const { section } = sectionFor(5); section.block_states.data.pop(); assert.throws(() => decodeSection(section), { code: 'BLOCK_DATA' });
  section.block_states.data.push('0', '0'); assert.throws(() => decodeSection(section), { code: 'BLOCK_DATA' });
});

test('single-state sections retain zero indices and reject unexpected packed data', () => {
  const section = { Y: 0, block_states: { palette: [{ Name: 'minecraft:cave_air' }] } };
  assert.equal(decodeSection(section).indices.every(v => v === 0), true);
  section.block_states.data = []; assert.equal(decodeSection(section).indices.length, 4096);
  section.block_states.data = ['0']; assert.throws(() => decodeSection(section), { code: 'BLOCK_DATA' });
});
