import { createChunkReader, isAir, isFluid } from '../engine/chunks.js';
import { inspectWorld } from '../engine/world.js';

const stores = ['region', 'entities', 'poi'];
const coordinate = n => Number.isSafeInteger(n) && Math.abs(n) <= 1874999;
function dimension(world, id) {
  const matches = world.dimensions.filter(d => d.id === id);
  if (matches.length !== 1) throw new Error('Dimension is missing or ambiguous');
  return matches[0];
}
/** Read-only research contract. Never an approval token or input to an engine writer. */
export function previewRegionImport(sourceRoot, destinationRoot, { dimensionId = 'minecraft:overworld', chunks, offset = { x: 0, z: 0 }, protection = [] }) {
  if (!Array.isArray(chunks) || !chunks.length || chunks.length > 64 || !chunks.every(c => coordinate(c.x) && coordinate(c.z)) || !coordinate(offset.x) || !coordinate(offset.z) || new Set(chunks.map(c => `${c.x},${c.z}`)).size !== chunks.length) throw new Error('Use 1–64 unique chunk coordinates and a bounded whole-chunk offset');
  if (!Array.isArray(protection) || !protection.every(c => coordinate(c.x) && coordinate(c.z) && typeof c.dimension === 'string')) throw new Error('Protection must include dimension IDs and chunk coordinates');
  const source = inspectWorld(sourceRoot), destination = inspectWorld(destinationRoot);
  const sd = dimension(source, dimensionId), dd = dimension(destination, dimensionId);
  const sr = createChunkReader(source.root, sd), dr = createChunkReader(destination.root, dd);
  const blockers = [], mappings = [];
  if (source.metadata.dataVersion !== destination.metadata.dataVersion || source.metadata.version !== destination.metadata.version) blockers.push('VERSION_MISMATCH');
  if (source.metadata.seed === null || destination.metadata.seed === null) blockers.push('SEED_UNKNOWN');
  else if (source.metadata.seed !== destination.metadata.seed) blockers.push('SEED_MISMATCH');
  if (source.validationErrors.length || destination.validationErrors.length || [sd, dd].some(d => d.issues.length || d.regions.some(r => r.issues.length))) blockers.push('WORLD_STRUCTURE_INVALID');
  const sourceEntities = new Set(), destinationEntities = new Set();
  for (const c of chunks) {
    const target = { x: c.x + offset.x, z: c.z + offset.z };
    if (!coordinate(target.x) || !coordinate(target.z)) throw new Error('Translated coordinates are outside the research bounds');
    const conflicts = [], records = {};
    if (protection.some(p => p.dimension === dimensionId && p.x === target.x && p.z === target.z)) conflicts.push('PROTECTED_DESTINATION');
    for (const store of stores) {
      try {
        const a = sr.read(c.x, c.z, store), b = dr.read(target.x, target.z, store);
        records[store] = { sourcePresent: Boolean(a), destinationPresent: Boolean(b), payloadEqual: a && b ? a.raw.equals(b.raw) : null };
        // Even identical occupied records are not permission to overwrite existing terrain.
        if (b) conflicts.push(`DESTINATION_${store.toUpperCase()}_OCCUPIED`);
        if (store === 'region' && !a) conflicts.push('SOURCE_TERRAIN_MISSING');
        if (a && a.nbt.DataVersion !== source.metadata.dataVersion || b && b.nbt.DataVersion !== destination.metadata.dataVersion) conflicts.push('RECORD_VERSION_MISMATCH');
        if (store === 'entities') {
          for (const e of a?.nbt.Entities ?? []) if (e.UUID) sourceEntities.add(JSON.stringify(e.UUID));
          for (const e of b?.nbt.Entities ?? []) if (e.UUID) destinationEntities.add(JSON.stringify(e.UUID));
        }
        if (store === 'region' && a && (a.nbt.blending_data || a.nbt.below_zero_retrogen || a.nbt.UpgradeData)) conflicts.push('PENDING_GENERATION_METADATA');
      } catch (error) { records[store] = { unreadable: error.code ?? error.message }; conflicts.push('UNREADABLE_RECORD'); }
    }
    mappings.push({ source: c, target, region: { x: Math.floor(target.x / 32), z: Math.floor(target.z / 32) }, conflicts: [...new Set(conflicts)], records });
  }
  const uuidCollisions = [...sourceEntities].filter(u => destinationEntities.has(u)).length;
  if (uuidCollisions) blockers.push('ENTITY_UUID_COLLISION_IN_SELECTED_RECORDS');
  sr.verifyStable(); dr.verifyStable();
  if (inspectWorld(source.root).inventoryFingerprint !== source.inventoryFingerprint || inspectWorld(destination.root).inventoryFingerprint !== destination.inventoryFingerprint) throw new Error('World inventory changed during research');
  return { schemaVersion: 1, kind: 'region-import-research', executable: false, gameLoadTested: false,
    dimensionId, offset, mappings, blockers, uuidCollisions,
    unresolved: ['Entity UUID audit covers selected destination records only; other dimensions/chunks are unscanned.', 'Block entities, entity positions/passengers, POI, ticks, structures and gateway targets require relocation adapters.', 'Global player, map, scoreboard and dragon-fight data cannot be merged by copying region files.', 'No automatic portal relinking, version conversion, seed reconciliation or terrain blending exists.'] };
}

/** Compare explicit paired boundary columns. Metrics are diagnostics, never a blending guarantee. */
export function inspectSeam(sourceRoot, destinationRoot, { dimensionId = 'minecraft:overworld', pairs, minY, maxY, protection = [] }) {
  if (!Array.isArray(pairs) || !pairs.length || pairs.length > 64 || !Number.isInteger(minY) || !Number.isInteger(maxY) || minY < -64 || maxY > 319 || minY > maxY || pairs.length * (maxY - minY + 1) > 8192 || !pairs.every(p => [p.source, p.destination].every(c => c && Number.isSafeInteger(c.x) && Number.isSafeInteger(c.z) && Math.abs(c.x) <= 29999999 && Math.abs(c.z) <= 29999999))) throw new Error('Invalid or excessive seam sample');
  if (!Array.isArray(protection) || !protection.every(c => coordinate(c.x) && coordinate(c.z) && typeof c.dimension === 'string')) throw new Error('Invalid protection coordinates');
  const a = inspectWorld(sourceRoot), b = inspectWorld(destinationRoot), ad = dimension(a, dimensionId), bd = dimension(b, dimensionId);
  const ar = createChunkReader(a.root, ad), br = createChunkReader(b.root, bd);
  const metrics = { samples: 0, unknown: 0, occupancyMismatch: 0, fluidContacts: 0, bedrockContacts: 0, protectedSamples: 0, maxWindowTopDelta: null };
  const issues = new Set();
  for (const pair of pairs) {
    let atop = null, btop = null, complete = true;
    for (let y = minY; y <= maxY; y++) {
      metrics.samples++;
      if (protection.some(p => p.dimension === dimensionId && p.x === Math.floor(pair.destination.x / 16) && p.z === Math.floor(pair.destination.z / 16))) metrics.protectedSamples++;
      let aa, bb;
      try { aa = ar.block(pair.source.x, y, pair.source.z); bb = br.block(pair.destination.x, y, pair.destination.z); }
      catch (error) { issues.add(error.code ?? error.message); }
      if (!aa || !bb) { metrics.unknown++; complete = false; continue; }
      if (!isAir(aa)) atop = y; if (!isAir(bb)) btop = y;
      if (isAir(aa) !== isAir(bb)) metrics.occupancyMismatch++;
      if (isFluid(aa) || isFluid(bb)) metrics.fluidContacts++;
      if (aa.Name === 'minecraft:bedrock' || bb.Name === 'minecraft:bedrock') metrics.bedrockContacts++;
    }
    if (complete && atop !== null && btop !== null) metrics.maxWindowTopDelta = Math.max(metrics.maxWindowTopDelta ?? 0, Math.abs(atop - btop));
  }
  ar.verifyStable(); br.verifyStable();
  return { schemaVersion: 1, kind: 'seam-research', executable: false, blended: false, seamlessnessProven: false,
    minY, maxY, metrics, issues: [...issues], limitations: ['Top height is bounded to the supplied Y window, not a terrain heightmap.', 'Equal sampled heights do not establish cave, biome, structure, lighting, fluid or gameplay continuity.', 'Missing/unsupported data stays unknown. Protected samples and bedrock must never be changed by a future solver.'] };
}
