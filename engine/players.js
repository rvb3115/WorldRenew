import fs from 'node:fs';
import path from 'node:path';
import { decodeDat, NBT_LIMITS } from './nbt.js';
import { readBounded, safePath } from './paths.js';
import { requireThat } from './errors.js';

const compound = v => v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v);
const dimensionId = v => typeof v === 'string' && /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(v);
export function uuidString(value) {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isInteger)) return null;
  const hex = value.map(n => (n >>> 0).toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export function playerFiles(root) {
  const files = [];
  for (const directory of ['players/data', 'playerdata']) {
    try {
      const entries = fs.readdirSync(safePath(root, directory), { withFileTypes: true });
      requireThat(entries.length + files.length <= 10000, 'PLAYER_LIMIT', 'Player folders exceed the 10,000-entry review limit.');
      files.push(...entries.map(e => path.join(directory, e.name)));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return files.sort();
}

/** Read-only anchor checks, not account migration or an inventory editor. Unknown schemas fail closed. */
export function inspectPlayerSafety(world, candidates, bufferChunks, snapshot) {
  const blockers = [], anchors = [], players = [], files = [];
  const read = relative => { snapshot(relative); return decodeDat(readBounded(world.root, relative, NBT_LIMITS.compressed)); };
  function anchor(source, kind, dimension, pos) {
    if (!dimensionId(dimension) || !Array.isArray(pos) || pos.length !== 3 || !pos.every(Number.isFinite) || pos.some(n => Math.abs(n) > 30000000)) {
      blockers.push(`${source}: unrecognized ${kind}; export cannot establish player safety.`); return;
    }
    anchors.push({ source, kind, dimension, position: pos, x: Math.floor(pos[0] / 16), z: Math.floor(pos[2] / 16) });
  }
  function respawn(source, data) {
    if (!compound(data)) { blockers.push(`${source}: unrecognized respawn data.`); return; }
    anchor(source, 'respawn', data.dimension, data.pos);
  }
  function player(source, data, filenameUuid = null) {
    if (!compound(data)) { blockers.push(`${source}: missing player compound.`); return; }
    const uuid = uuidString(data.UUID);
    if (!uuid || (filenameUuid && uuid !== filenameUuid)) blockers.push(`${source}: UUID is missing or does not match its filename.`);
    if (data.DataVersion !== undefined && data.DataVersion !== world.metadata.dataVersion) blockers.push(`${source}: player DataVersion differs from the world; migrate a copy in Minecraft first.`);
    anchor(source, 'saved position', data.Dimension, data.Pos);
    if (data.respawn !== undefined) respawn(source, data.respawn);
    // Older saves can still be inspected; no rewriting or implicit migration is performed.
    if (['SpawnX', 'SpawnY', 'SpawnZ', 'SpawnDimension'].some(k => data[k] !== undefined)) {
      anchor(source, 'legacy respawn', data.SpawnDimension ?? 'minecraft:overworld', [data.SpawnX, data.SpawnY, data.SpawnZ]);
    }
    if (data.RootVehicle || data.ender_pearls?.length) blockers.push(`${source}: vehicle or ender-pearl dependencies require manual review before export.`);
    players.push({ source, uuid, inventoryEntries: Array.isArray(data.Inventory) ? data.Inventory.length : null,
      enderChestEntries: Array.isArray(data.EnderItems) ? data.EnderItems.length : null });
  }
  const level = read('level.dat').Data;
  if (level.spawn !== undefined) respawn('World spawn', level.spawn);
  else anchor('World spawn', 'spawn', 'minecraft:overworld', [level.SpawnX, level.SpawnY, level.SpawnZ]);
  if (level.Player !== undefined) player('level.dat:Player', level.Player);
  try { files.push(...playerFiles(world.root)); }
  catch (error) { blockers.push(`Player data: ${error.message}`); }
  let totalBytes = 0;
  for (const file of files) {
    try {
      const entry = snapshot(file); totalBytes += entry.bytes;
      requireThat(totalBytes <= 128 * 1024 * 1024, 'PLAYER_LIMIT', 'Player data exceeds the 128 MiB review limit.');
      const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.dat$/i.exec(path.basename(file));
      if (match) player(file, read(file), match[1].toLowerCase());
      else if (!file.endsWith('.dat_old')) blockers.push(`${file}: unrecognized player file; review before export.`);
    } catch (error) { blockers.push(`${file}: ${error.message}`); }
  }
  if (level.singleplayer_uuid !== undefined) {
    const uuid = uuidString(level.singleplayer_uuid);
    if (!uuid || !players.some(p => p.uuid === uuid)) blockers.push('The singleplayer UUID has no matching readable player record.');
  }
  const diskPlayers = players.filter(p => p.source !== 'level.dat:Player');
  if (new Set(diskPlayers.map(p => p.uuid)).size !== diskPlayers.length) blockers.push('Duplicate player UUIDs across storage layouts need manual migration review.');
  const radiusChunks = Math.max(1, bufferChunks), ids = new Map(world.dimensions.map(d => [d.key, d.id]));
  const conflicts = anchors.flatMap(a => candidates.filter(c => ids.get(c.dimension) === a.dimension && Math.abs(c.x-a.x) <= radiusChunks && Math.abs(c.z-a.z) <= radiusChunks)
    .map(c => ({ source: a.source, kind: a.kind, anchor: { dimension: a.dimension, x: a.x, z: a.z }, chunk: c })));
  for (const c of conflicts) blockers.push(`${c.source}: ${c.kind} safety area overlaps refresh chunk ${c.chunk.x}, ${c.chunk.z}. Protect this area and preview again.`);
  return { players, anchors, conflicts, radiusChunks, files, blockers: [...new Set(blockers)],
    limitations: 'Files and UUIDs are retained unchanged. No account remapping, safe landing simulation, inventory migration, farm adaptation or Realm login certification. Anchor buffers cannot cover all beds, vehicles, portals or farm dependencies.' };
}
