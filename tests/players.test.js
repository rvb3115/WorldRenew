import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preservationWorld, playerTags, playerPath, levelTags, spawnTag } from './preservation-fixtures.js';
import { writeDat } from './fixtures.js';
import { inspectWorld } from '../engine/world.js';
import { createRegenerationReview } from '../engine/regeneration.js';
import { createRegeneratedCopy } from '../engine/regeneration-export.js';
import { createVerifiedCopy, inventory, hashFile } from '../engine/safety.js';
import { decodeDat, parseNBT } from '../engine/nbt.js';
import { inflateSync } from 'node:zlib';

const ack = { confirmedClosed: true, confirmedExperimental: true };
function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'worldrenew-players-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = preservationWorld(path.join(base, 'source'));
  const world = () => inspectWorld(root), c = x => ({ dimension: world().dimensions.find(d => d.id === 'minecraft:overworld').key, x, z: 0 });
  const review = (selection = [c(0), c(4)], protection = [c(0)]) => createRegenerationReview(world(), selection, protection, { bufferChunks: 1 });
  return { root, base, world, c, review };
}
const hashes = root => inventory(root).files.map(f => [f.path, hashFile(path.join(root, f.path))]);

test('protected blocks, chest, villager, POI, UUIDs, inventories, positions and progress survive export; backup restores byte-exactly', t => {
  const f = setup(t), before = hashes(f.root), plan = f.review();
  assert.equal(plan.copyExport.eligible, true); assert.equal(plan.playerSafety.players.length, 2);
  const result = createRegeneratedCopy(f.world(), plan, f.base, ack);
  assert.deepEqual(hashes(f.root), before); assert.deepEqual(hashes(result.backup), before);
  for (const store of ['region', 'entities', 'poi']) {
    const relative = `dimensions/minecraft/overworld/${store}/r.0.0.mca`, original = fs.readFileSync(path.join(f.root, relative)), output = fs.readFileSync(path.join(result.world, relative));
    // Independent expected-byte construction also covers the protected record, timestamp and unused sectors.
    const expected = Buffer.from(original); expected.fill(0, 16, 20); expected.fill(0, 4112, 4116); assert.deepEqual(output, expected);
    assert.equal(output.readUInt32BE(0), original.readUInt32BE(0));
    const offset = (output.readUInt32BE(0) >>> 8) * 4096, length = output.readUInt32BE(offset);
    const data = parseNBT(inflateSync(output.subarray(offset + 5, offset + 4 + length)));
    if (store === 'region') { assert.equal(data.sections[0].block_states.palette[0].id, 'minecraft:oak_planks'); assert.equal(data.block_entities[0].Items[0].count, 17); }
    if (store === 'entities') assert.equal(data.Entities[0].id, 'minecraft:villager');
    if (store === 'poi') assert.equal(data.Sections['4'].Records[0].type, 'minecraft:home');
  }
  for (const [relative, hash] of before.filter(([p]) => /^(players|playerdata|stats|advancements)\//.test(p) || p === 'level.dat')) assert.equal(hashFile(path.join(result.world, relative)), hash);
  const player = decodeDat(fs.readFileSync(path.join(result.world, playerPath())));
  assert.deepEqual(player.Pos, [8.5, 65, 8.5]); assert.equal(player.Inventory[0].count, 17); assert.equal(player.EnderItems[0].count, 8); assert.equal(player.XpLevel, 42);
  const restored = createVerifiedCopy(result.backup, f.base, { confirmedClosed: true }); assert.deepEqual(hashes(restored.world), before);
});

for (const [label, fields] of [
  ['saved position', { Pos: [9, { type: 6, values: [64, 65, 0] }] }],
  ['modern respawn', { respawn: spawnTag([64, 65, 0]) }],
  ['legacy respawn', { SpawnX: [3, 64], SpawnY: [3, 65], SpawnZ: [3, 0] }],
  ['unknown dimension', { Dimension: [3, 0] }],
  ['invalid position', { Pos: [9, { type: 6, values: [NaN, 65, 0] }] }],
  ['mismatched UUID', { UUID: [11, [5, 6, 7, 8]] }],
  ['old player version', { DataVersion: [3, 4903] }],
  ['vehicle dependency', { RootVehicle: [10, {}] }],
]) test(`${label} blocks export without creating output`, t => {
  const f = setup(t); writeDat(path.join(f.root, playerPath()), playerTags(0, fields)); const plan = f.review();
  assert.equal(plan.copyExport.eligible, false); assert.throws(() => createRegeneratedCopy(f.world(), plan, f.base, ack), { code: 'EXPORT_BLOCKED' });
  assert.deepEqual(fs.readdirSync(f.base), ['source']);
});

test('world spawn, negative coordinates and minimum one-chunk safety radius are enforced', t => {
  const f = setup(t); writeDat(path.join(f.root, 'level.dat'), levelTags({ spawn: spawnTag([48, 65, 0]) }));
  assert.ok(f.review().playerSafety.conflicts.some(c => c.source === 'World spawn'));
  writeDat(path.join(f.root, playerPath()), playerTags(0, { Pos: [9, { type: 6, values: [-0.1, 65, -0.1] }] }));
  assert.ok(f.review().playerSafety.anchors.some(a => a.kind === 'saved position' && a.x === -1 && a.z === -1));
  const plan = createRegenerationReview(f.world(), [f.c(4)], [], { bufferChunks: 0 });
  assert.equal(plan.playerSafety.radiusChunks, 1); assert.equal(plan.copyExport.eligible, false);
});

test('embedded legacy singleplayer data is reviewed as well as multiplayer files', t => {
  const f = setup(t); writeDat(path.join(f.root, 'level.dat'), levelTags({ Player: [10, playerTags(0, { Pos: [9, { type: 6, values: [64, 65, 0] }] })] }));
  assert.ok(f.review().playerSafety.conflicts.some(c => c.source === 'level.dat:Player'));
});

test('corrupt, missing owner, symlinked and unrecognized player files fail closed', t => {
  const f = setup(t), file = path.join(f.root, playerPath()); fs.writeFileSync(file, 'bad'); assert.equal(f.review().copyExport.eligible, false);
  fs.unlinkSync(file); assert.equal(f.review().copyExport.eligible, false);
  fs.symlinkSync(path.join(f.root, 'level.dat'), file); assert.equal(f.review().copyExport.eligible, false);
  fs.unlinkSync(file); writeDat(file, playerTags()); fs.writeFileSync(path.join(f.root, 'players/data/unknown.dat'), 'x'); assert.equal(f.review().copyExport.eligible, false);
});

test('player edits, new accounts and same-size inventory changes invalidate prior consent', t => {
  const f = setup(t), plan = f.review();
  writeDat(path.join(f.root, playerPath()), playerTags(0, { XpLevel: [3, 43] }));
  assert.throws(() => createRegeneratedCopy(f.world(), plan, f.base, ack), { code: 'REVIEW_STALE' });
  const next = f.review(); fs.copyFileSync(path.join(f.root, playerPath()), path.join(f.root, 'players/data/00000000-0000-0000-0000-000000000000.dat'));
  assert.throws(() => createRegeneratedCopy(f.world(), next, f.base, ack), { code: 'REVIEW_STALE' });
});

test('invented DataVersion cannot authorize export under a 26.3 label', t => {
  const f = setup(t); writeDat(path.join(f.root, 'level.dat'), levelTags({ DataVersion: [3, 999999], Version: [10, { Name: [8, '26.3'], Id: [3, 999999] }] }));
  assert.ok(f.review().copyExport.blockers.some(b => b.includes('5023')));
});

 test('legacy playerdata is inspected and conflicting mixed layouts are blocked', t => {
  const f = setup(t);
  fs.renameSync(path.join(f.root, 'players/data'), path.join(f.root, 'playerdata'));
  assert.equal(f.review().playerSafety.players.length, 2); assert.equal(f.review().copyExport.eligible, true);
  writeDat(path.join(f.root, playerPath()), playerTags());
  assert.ok(f.review().copyExport.blockers.some(b => b.includes('Duplicate player UUID')));
});
