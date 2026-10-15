import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFixture, dimensions, regionPath, playerIds } from './fixtures.mjs';
import { treeHashes, record } from './oracle.mjs';
import { inspectWorld } from '../engine/world.js';
import { createRegenerationReview } from '../engine/regeneration.js';
import { createRegeneratedCopy } from '../engine/regeneration-export.js';
import { createChunkReader } from '../engine/chunks.js';
import { decodeDat } from '../engine/nbt.js';
import { writeDat } from '../tests/fixtures.js';
import { captureVolume } from '../engine/volumes.js';
import { portalReview } from '../engine/dimensions.js';

const ack = { confirmedClosed: true, confirmedExperimental: true };
function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'worldrenew-qa-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = createFixture(path.join(base, 'synthetic-source')), world = inspectWorld(root);
  const c = (x, z = 0, d = 'overworld') => ({ dimension: world.dimensions.find(v => v.id === `minecraft:${d}`).key, x, z });
  return { base, root, world, c };
}
function exportFixture(f) {
  const protection = dimensions.map(d => f.c(0, 0, d));
  const review = createRegenerationReview(f.world, [f.c(0), f.c(1), f.c(4)], protection, { bufferChunks: 1 });
  assert.deepEqual(review.candidates, [f.c(4)]);
  assert.deepEqual(review.excludedProtected, [f.c(0)]);
  assert.deepEqual(review.excludedBuffer, [f.c(1)]);
  assert.equal(review.copyExport.eligible, true, review.copyExport.blockers.join('\n'));
  return createRegeneratedCopy(f.world, review, f.base, ack);
}

test('owned export preserves source/backup, protected and buffered records, every unselected byte and all three stores', t => {
  const f = setup(t), before = treeHashes(f.root), result = exportFixture(f);
  assert.deepEqual(treeHashes(f.root), before);
  assert.deepEqual(treeHashes(result.backup), before);
  const after = treeHashes(result.world);
  assert.deepEqual(Object.keys(after), Object.keys(before));
  const modified = new Set(['region', 'entities', 'poi'].map(s => regionPath('overworld', s)));
  for (const [file, sha] of Object.entries(before)) {
    if (!modified.has(file)) { assert.equal(after[file], sha, file); continue; }
    for (const x of [0, 1, 31]) {
      const a = record(path.join(f.root, file), x, 0), b = record(path.join(result.world, file), x, 0);
      assert.ok(a && b); assert.deepEqual(b.compressed, a.compressed); assert.equal(b.timestamp, a.timestamp);
    }
    assert.ok(record(path.join(f.root, file), 4, 0));
    assert.equal(record(path.join(result.world, file), 4, 0), null);
    const a = fs.readFileSync(path.join(f.root, file)), b = fs.readFileSync(path.join(result.world, file));
    const changedBytes = [...a.keys()].filter(i => a[i] !== b[i]);
    assert.ok(changedBytes.length > 0);
    assert.ok(changedBytes.every(i => i >= 16 && i < 20 || i >= 4112 && i < 4116));
  }
  assert.equal(JSON.parse(fs.readFileSync(result.report)).gameLoadTested, false);
});

test('UUID, inventory, ender chest, XP, position, respawn and progress files survive for players in every dimension', t => {
  const f = setup(t), result = exportFixture(f);
  for (const [i, d] of dimensions.entries()) {
    const file = `players/data/${playerIds[i]}.dat`, old = fs.readFileSync(path.join(f.root, file)), bytes = fs.readFileSync(path.join(result.world, file));
    assert.deepEqual(bytes, old);
    const player = decodeDat(bytes);
    assert.deepEqual(player.UUID, [1, 2, 3, 4].map(n => n + i * 4));
    assert.equal(player.Dimension, `minecraft:${d}`); assert.deepEqual(player.Pos, [8.5, d === 'the_nether' ? 130 : 65, 8.5]);
    assert.equal(player.Inventory[0].id, 'minecraft:diamond'); assert.equal(player.Inventory[0].count, 17);
    assert.deepEqual(player.EnderItems, player.Inventory); assert.equal(player.XpLevel, 42);
    assert.equal(player.respawn.dimension, `minecraft:${d}`);
    for (const folder of ['stats', 'advancements']) assert.deepEqual(fs.readFileSync(path.join(result.world, `players/${folder}/${playerIds[i]}.json`)), fs.readFileSync(path.join(f.root, `players/${folder}/${playerIds[i]}.json`)));
  }
});

test('Nether roof air hole, access ladder, hub and portal blocks survive; coordinate guidance never claims connectivity', t => {
  const f = setup(t), result = exportFixture(f), world = inspectWorld(result.world);
  const dim = world.dimensions.find(d => d.id === 'minecraft:the_nether'), reader = createChunkReader(world.root, dim);
  assert.equal(reader.block(3, 127, 3).Name, 'minecraft:air');
  assert.equal(reader.block(4, 127, 3).Name, 'minecraft:bedrock');
  assert.deepEqual(reader.block(3, 126, 3), { Name: 'minecraft:ladder', Properties: { facing: 'north', waterlogged: 'false' } });
  assert.equal(reader.block(4, 128, 3).Name, 'minecraft:stone_bricks');
  assert.equal(reader.block(1, 129, 1).Name, 'minecraft:nether_portal');
  const volume = captureVolume(world, dim.key, { minX: 0, maxX: 7, minY: 126, maxY: 130, minZ: 0, maxZ: 7 });
  const portals = portalReview(volume, dim.id, dim.id, { x: 0, y: 126, z: 0 });
  assert.equal(portals.linksValidated, false); assert.equal(portals.portalBlocks, 1);
  assert.deepEqual(portals.samples[0].oppositeTarget, { x: 8, z: 8 });
  const ow = createChunkReader(world.root, world.dimensions.find(d => d.id === 'minecraft:overworld'));
  assert.equal(ow.block(8, 65, 8).Name, 'minecraft:nether_portal');
  assert.ok(portals.warnings.some(w => w.includes('No links have been validated')));
});

test('End gateway exit payload, destination chunk, global End metadata and farm blocks/entities/POI survive', t => {
  const f = setup(t), result = exportFixture(f);
  for (const d of dimensions) {
    const terrain = record(path.join(result.world, regionPath(d, 'region')), 0, 0).nbt;
    const attachment = terrain.block_entities[0];
    if (d === 'the_end') {
      assert.deepEqual({ ...attachment.ExitPortal }, { X: 104, Y: 75, Z: 8 });
      assert.equal(attachment.ExactTeleport, 1);
      assert.ok(record(path.join(result.world, regionPath(d, 'region')), 6, 0));
    } else assert.equal(attachment.Items[0].count, 17);
    const entities = record(path.join(result.world, regionPath(d, 'entities')), 0, 0).nbt.Entities;
    assert.equal(entities[0].id, d === 'the_end' ? 'minecraft:endermite' : 'minecraft:villager');
    assert.equal(record(path.join(result.world, regionPath(d, 'poi')), 0, 0).nbt.Sections['4'].Records[0].type, 'minecraft:home');
  }
  const world = inspectWorld(result.world), reader = createChunkReader(world.root, world.dimensions.find(d => d.id === 'minecraft:overworld'));
  for (const [i, name] of ['hopper', 'chest', 'rail', 'red_bed', 'comparator'].entries()) assert.equal(reader.block(i + 2, 65, 2).Name, `minecraft:${name}`);
  const file = 'dimensions/minecraft/the_end/data/minecraft/dragon_fight.dat';
  assert.deepEqual(fs.readFileSync(path.join(result.world, file)), fs.readFileSync(path.join(f.root, file)));
});

for (const d of ['the_nether', 'the_end']) test(`${d} removal is preview-only and cannot create an export`, t => {
  const f = setup(t), before = treeHashes(f.root);
  const review = createRegenerationReview(f.world, [f.c(4, 0, d)], [], { bufferChunks: 0 });
  assert.equal(review.copyExport.eligible, false);
  assert.throws(() => createRegeneratedCopy(f.world, review, f.base, ack), { code: 'EXPORT_BLOCKED' });
  assert.deepEqual(treeHashes(f.root), before); assert.deepEqual(fs.readdirSync(f.base), ['synthetic-source']);
});

test('player saved-position risk blocks refresh despite unprotected terrain', t => {
  const f = setup(t), review = createRegenerationReview(f.world, [f.c(1)], [], { bufferChunks: 0 });
  assert.ok(review.playerSafety.conflicts.length); assert.equal(review.copyExport.eligible, false);
  assert.throws(() => createRegeneratedCopy(f.world, review, f.base, ack), { code: 'EXPORT_BLOCKED' });
});

test('player change after preview invalidates export without creating a working copy', t => {
  const f = setup(t), review = createRegenerationReview(f.world, [f.c(4)], [f.c(0)], { bufferChunks: 1 });
  const file = path.join(f.root, `players/data/${playerIds[0]}.dat`);
  // Corrupt only our generated fixture; never a user-provided world.
  const bytes = fs.readFileSync(file); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(file, bytes);
  const before = treeHashes(f.root);
  assert.throws(() => createRegeneratedCopy(f.world, review, f.base, ack), { code: 'REVIEW_STALE' });
  assert.deepEqual(treeHashes(f.root), before); assert.deepEqual(fs.readdirSync(f.base), ['synthetic-source']);
});

test('unknown DataVersion cannot gain export support from a 26.3 label', t => {
  const f = setup(t), file = path.join(f.root, 'level.dat');
  writeDat(file, { Data: [10, { DataVersion: [3, 999999], Version: [10, { Name: [8, '26.3'], Id: [3, 999999], Snapshot: [1, 0] }], SpawnX: [3, 8], SpawnY: [3, 65], SpawnZ: [3, 8] }] });
  const world = inspectWorld(f.root), review = createRegenerationReview(world, [f.c(4)], [], { bufferChunks: 0 });
  assert.equal(review.copyExport.eligible, false); assert.ok(review.copyExport.blockers.some(b => b.includes('DataVersion')));
});
