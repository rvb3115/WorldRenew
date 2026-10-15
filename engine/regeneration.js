import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { inspectWorld } from './world.js';
import { inspectRegion } from './anvil.js';
import { safePath } from './paths.js';
import { hashFile } from './safety.js';
import { previewRegeneration } from './plans.js';
import { projectDirectoryOutsideWorld, validateProtection } from './projects.js';
import { requireThat } from './errors.js';
import { regenerationExportPolicy } from './versions.js';
import { inspectPlayerSafety, playerFiles } from './players.js';

const stores = ['region', 'entities', 'poi'];
const key = c => `${c.dimension}:${c.x},${c.z}`;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const order = (a, b) => a.dimension.localeCompare(b.dimension) || a.x - b.x || a.z - b.z;
const stamp = stat => [stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino];
export const REGENERATION_LIMIT = 10000;

function fileSnapshot(root, relative) {
  try {
    const file = safePath(root, relative), before = fs.statSync(file);
    requireThat(before.isFile(), 'REVIEW_FILE', `Not a regular file: ${relative}`);
    const sha256 = hashFile(file), after = fs.statSync(file);
    requireThat(JSON.stringify(stamp(before)) === JSON.stringify(stamp(after)), 'REVIEW_CHANGED', `File changed during review: ${relative}. Refresh the world.`);
    return { path: relative, present: true, bytes: before.size, sha256 };
  } catch (error) {
    if (error.code === 'ENOENT') return { path: relative, present: false };
    throw error;
  }
}

/** Read-only review. File hashes describe inputs, never permission to write them. */
export function createRegenerationReview(world, selected, protection, { bufferChunks = 1 } = {}, progress = () => {}) {
  requireThat(Array.isArray(selected) && selected.length > 0 && selected.length <= REGENERATION_LIMIT, 'REVIEW_LIMIT', `Choose between 1 and ${REGENERATION_LIMIT.toLocaleString()} chunks per detailed review.`);
  requireThat(Number.isInteger(bufferChunks) && bufferChunks >= 0 && bufferChunks <= 8, 'REVIEW_BUFFER', 'Protection buffer must be a whole number from 0 to 8 chunks.');
  progress({ phase: 'Rechecking world inventory' });
  const fresh = inspectWorld(world.root);
  requireThat(fresh.inventoryFingerprint === world.inventoryFingerprint, 'REVIEW_STALE', 'World files changed since inspection. Refresh the world and review your protection plan.');
  const selectedChunks = validateProtection(fresh, selected).sort(order), protectedChunks = validateProtection(fresh, protection).sort(order);
  const preview = previewRegeneration(fresh, selectedChunks, protectedChunks);
  const protectedKeys = new Set(protectedChunks.map(key)), excludedBuffer = [], candidates = [];
  for (const c of preview.candidates) {
    let buffered = false;
    for (let dx = -bufferChunks; dx <= bufferChunks && !buffered; dx++) for (let dz = -bufferChunks; dz <= bufferChunks; dz++) {
      if (protectedKeys.has(key({ dimension: c.dimension, x: c.x + dx, z: c.z + dz }))) { buffered = true; break; }
    }
    (buffered ? excludedBuffer : candidates).push(c);
  }
  const blockers = [...fresh.validationErrors];
  for (const d of fresh.dimensions) {
    blockers.push(...d.issues);
    for (const r of d.regions) blockers.push(...r.issues.map(issue => `${r.path}: ${issue}`));
  }
  if (fresh.metadata.dataVersion === null) blockers.push('DataVersion is unavailable.');
  if (!candidates.length) blockers.push('No candidate chunks remain after protection and its buffer.');
  const dimensions = new Map(fresh.dimensions.map(d => [d.key, d]));
  const regionCache = new Map(), snapshots = new Map(), records = [], warnings = [
    ...(fresh.metadata.configuration?.notices ?? []),
    'Header and file checks only. Block contents, structures crossing chunk boundaries, entities, POI semantics and gameplay integrity are not certified.',
    'Minecraft generates missing terrain when a future exported copy is opened. WorldRenew does not generate terrain or change DataVersion.',
    'A protection buffer preserves whole neighboring chunk columns, including diagonal neighbors; it cannot guarantee seamless terrain or intact structures.'
  ];
  const snapshot = relative => {
    if (!snapshots.has(relative)) snapshots.set(relative, fileSnapshot(fresh.root, relative));
    return snapshots.get(relative);
  };
  snapshot('level.dat'); snapshot('data/minecraft/world_gen_settings.dat');
  const counts = { region: 0, entities: 0, poi: 0, external: 0, absent: 0, invalid: 0 };
  for (const [index, c] of candidates.entries()) {
    const d = dimensions.get(c.dimension), rx = Math.floor(c.x / 32), rz = Math.floor(c.z / 32);
    progress({ phase: 'Reviewing coordinated chunk records', completed: index, total: candidates.length });
    for (const store of stores) {
      const relative = path.join(d.path, store, `r.${rx}.${rz}.mca`);
      if (!regionCache.has(relative)) {
        try {
          const file = snapshot(relative);
          const region = file.present ? inspectRegion(fresh.root, relative) : null;
          if (region) blockers.push(...region.issues.map(issue => `${relative}: ${issue}`));
          regionCache.set(relative, { region, chunks: new Map(region?.chunks.map(chunk => [`${chunk.x},${chunk.z}`, chunk]) ?? []) });
        } catch (error) {
          if (error.code === 'REVIEW_CHANGED') throw error;
          blockers.push(`${relative}: ${error.message}`);
          regionCache.set(relative, { error: error.message });
        }
      }
      const cached = regionCache.get(relative), chunk = cached.chunks?.get(`${c.x},${c.z}`);
      const record = { ...c, store, region: relative, status: cached.error ? 'unreadable' : chunk ? (chunk.valid ? 'present' : 'invalid') : 'absent', compression: chunk?.compression ?? null, external: chunk?.external ?? false };
      if (chunk) counts[store]++; else if (!cached.error) counts.absent++;
      if (cached.error || (chunk && !chunk.valid)) { counts.invalid++; record.issues = chunk?.issues ?? [cached.error]; }
      // Record absence too: a sidecar appearing later must invalidate the review.
      const sidecar = path.join(d.path, store, `c.${c.x}.${c.z}.mcc`);
      try {
        const external = snapshot(sidecar);
        if (chunk?.external) {
          record.sidecar = sidecar; counts.external++;
          if (!external.present || external.bytes === 0) blockers.push(`${sidecar}: external payload is missing or empty.`);
        } else if (external.present) {
          record.orphanSidecar = sidecar;
          blockers.push(`${sidecar}: sidecar has no matching external stub; its ownership needs review.`);
        }
      } catch (error) {
        if (error.code === 'REVIEW_CHANGED') throw error;
        blockers.push(`${sidecar}: ${error.message}`);
      }
      if (store === 'region' && !chunk) blockers.push(`${relative}: selected terrain record ${c.x}, ${c.z} is missing or unreadable.`);
      records.push(record);
    }
  }
  for (const dimension of new Set(candidates.map(c => c.dimension))) {
    const d = dimensions.get(dimension);
    if (d.id === 'minecraft:the_nether') warnings.push('Nether deletion needs portal-network review; Overworld portal chunks are not automatically protected.');
    else if (d.id === 'minecraft:the_end') warnings.push('End deletion needs dragon-fight, gateway and global-metadata review.');
    else if (d.id !== 'minecraft:overworld') warnings.push(`Custom dimension ${d.id} needs its own version and generation adapter.`);
    if (fresh.dimensions.filter(other => other.id === d.id).length > 1) blockers.push(`Ambiguous storage for ${d.id}: multiple layouts are present.`);
  }
  const playerSafety = inspectPlayerSafety(fresh, candidates, bufferChunks, snapshot);
  warnings.push(`${playerSafety.players.length} player records reviewed; ${playerSafety.anchors.length} saved-position/spawn anchors checked. ${playerSafety.limitations}`);
  progress({ phase: 'Verifying review inputs' });
  for (const file of snapshots.values()) requireThat(digest(fileSnapshot(fresh.root, file.path)) === digest(file), 'REVIEW_CHANGED', `Review inputs changed: ${file.path}. Refresh the world.`);
  requireThat(inspectWorld(fresh.root).inventoryFingerprint === fresh.inventoryFingerprint, 'REVIEW_CHANGED', 'World inventory changed during review. Refresh the world.');
  try { requireThat(digest(playerFiles(fresh.root)) === digest(playerSafety.files), 'REVIEW_CHANGED', 'Player file inventory changed during review.'); }
  catch (error) { if (error.code === 'REVIEW_CHANGED') throw error; playerSafety.blockers.push(error.message); }
  const uniqueBlockers = [...new Set(blockers)];
  const policy = regenerationExportPolicy(fresh.metadata, [...new Set(candidates.map(c => c.dimension))].map(id => dimensions.get(id)));
  const exportBlockers = [...uniqueBlockers, ...policy.blockers, ...playerSafety.blockers];
  const review = {
    schemaVersion: 1, type: preview.type, executable: false, status: uniqueBlockers.length ? 'blocked' : 'review-only',
    world: { root: fresh.root, name: fresh.metadata.name, version: fresh.metadata.version, dataVersion: fresh.metadata.dataVersion, inventoryFingerprint: fresh.inventoryFingerprint },
    selection: selectedChunks, protection: protectedChunks, bufferChunks, candidates, excludedProtected: preview.excludedProtected, excludedBuffer,
    counts: { selected: selectedChunks.length, candidates: candidates.length, protected: preview.excludedProtected.length, buffer: excludedBuffer.length, records: counts, inspectedRegionFiles: [...regionCache.values()].filter(r => r.region).length, affectedRegionFiles: new Set(records.filter(r => ['present', 'invalid'].includes(r.status)).map(r => r.region)).size },
    records, inputFiles: [...snapshots.values()].sort((a, b) => a.path.localeCompare(b.path)), blockers: uniqueBlockers, warnings,
    playerSafety, copyExport: { ...policy, eligible: exportBlockers.length === 0, blockers: exportBlockers },
    requiredGates: preview.requiredGates.map(gate => ({ gate, satisfied: false })),
    backup: { required: true, verified: false, explanation: 'Create a complete verified backup before any future write. A separate disposable working copy and post-write validation are also mandatory. This review cannot authorize deletion.' },
    explanation: preview.explanation
  };
  return { ...review, reviewDigest: digest(review), createdAt: new Date().toISOString() };
}

/** Recompute before saving so even same-size payload changes invalidate a displayed review. */
export function saveRegenerationReview(directory, world, review, progress = () => {}) {
  requireThat(review?.schemaVersion === 1 && review.executable === false && review.world?.root === world.root, 'REVIEW_SCHEMA', 'Run a regeneration review first.');
  const fresh = createRegenerationReview(world, review.selection, review.protection, { bufferChunks: review.bufferChunks }, progress);
  requireThat(fresh.reviewDigest === review.reviewDigest, 'REVIEW_STALE', 'Review inputs changed. Refresh the world and preview again before saving.');
  const safeDirectory = projectDirectoryOutsideWorld(directory, world);
  // Do not place reports inside any other Minecraft save either.
  for (let current = safeDirectory; ; current = path.dirname(current)) {
    requireThat(!fs.existsSync(path.join(current, 'level.dat')), 'REVIEW_IN_WORLD', 'Save review reports outside all Minecraft worlds.');
    if (path.dirname(current) === current) break;
  }
  fs.mkdirSync(safeDirectory, { recursive: true });
  const file = path.join(safeDirectory, `${randomUUID()}.worldrenew-regeneration.json`), temporary = `${file}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(fresh, null, 2), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return { file, reviewDigest: fresh.reviewDigest };
}
