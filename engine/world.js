import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { decodeDat, NBT_LIMITS } from './nbt.js';
import { canonicalWorld, readBounded, safePath } from './paths.js';
import { REGION_NAME, inspectRegion } from './anvil.js';
import { requireThat } from './errors.js';
import { configurationSummary } from './world-configuration.js';
import { versionPolicy, capabilities } from './versions.js';

const compound = v => v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v);
const string = v => typeof v === 'string' ? v : null;
const integer = v => Number.isSafeInteger(v) ? v : null;
const seedValue = v => typeof v === 'string' && /^-?\d+$/.test(v) ? v : null;

export function inspectWorld(folder, progress = () => {}) {
  const root = canonicalWorld(folder), issues = [], dimensions = [], seen = new Set(), regionInventory = [], validationErrors = [];
  const warn = message => { if (issues.length < 500) issues.push(message); };
  progress({ phase: 'Reading world metadata' });
  let bytes;
  try { bytes = readBounded(root, 'level.dat', NBT_LIMITS.compressed); }
  catch (error) { error.message = `Cannot read level.dat. Choose the Java world folder itself. ${error.message}`; throw error; }
  const level = decodeDat(bytes);
  requireThat(compound(level.Data), 'LEVEL_DATA', 'level.dat has no Data compound. Bedrock worlds are not supported.');
  const data = level.Data, version = compound(data.Version) ? data.Version : {};
  let seed = seedValue(data.WorldGenSettings?.seed) ?? seedValue(data.RandomSeed);
  const generationFile = 'data/minecraft/world_gen_settings.dat';
  let generationFingerprint = null, generationSettings = data.WorldGenSettings, generationSource = generationSettings ? 'level.dat:Data.WorldGenSettings' : null;
  try {
    const generationBytes = readBounded(root, generationFile, NBT_LIMITS.compressed);
    generationFingerprint = createHash('sha256').update(generationBytes).digest('hex');
    const generation = decodeDat(generationBytes);
    generationSettings = generation.data ?? generation.Data ?? generation; generationSource = generationFile;
    seed = seedValue(generation.data?.seed) ?? seedValue(generation.Data?.seed) ?? seedValue(generation.seed) ?? seed;
  } catch (error) { if (error.code !== 'ENOENT') { const message = `World-generation metadata: ${error.message}`; warn(message); validationErrors.push(message); } }
  const metadata = {
    name: string(data.LevelName) ?? path.basename(root), version: string(version.Name) ?? 'Unknown',
    dataVersion: integer(data.DataVersion) ?? integer(version.Id), versionId: integer(version.Id),
    configuration: configurationSummary(data, generationSettings, generationSource),
    snapshot: version.Snapshot === 1, seed, lastPlayed: string(data.LastPlayed),
    gameMode: integer(data.GameType), hardcore: data.hardcore === 1,
    spawn: Array.isArray(data.spawn?.pos) && data.spawn.pos.length === 3 && data.spawn.pos.every(Number.isSafeInteger)
      ? { x: data.spawn.pos[0], y: data.spawn.pos[1], z: data.spawn.pos[2], dimension: data.spawn.dimension }
      : [data.SpawnX, data.SpawnY, data.SpawnZ].every(Number.isSafeInteger) ? { x: data.SpawnX, y: data.SpawnY, z: data.SpawnZ } : null,
    policy: versionPolicy(string(version.Name), version.Snapshot === 1)
  };
  for (const note of metadata.configuration.notices) warn(note);
  if (seed === null) warn('Seed was not found in recognized metadata fields.');
  if (metadata.dataVersion === null) warn('DataVersion is missing or not an integer.');
  warn('Header inspection only: chunk block data, entities, POI contents and gameplay integrity have not been validated.');
  warn('Close Minecraft before inspecting or copying. A session.lock file alone does not prove whether the world is open.');
  let regionTotal = 0, chunkTotal = 0, directoryTotal = 0;
  function addDimension(id, relative, layout) {
    const key = `${id}|${relative}`; if (seen.has(key)) return; seen.add(key);
    const dim = { key, id, path: relative || '.', layout, regions: [], unreadableRegions: [], stores: { region: 0, entities: 0, poi: 0 }, chunkCount: 0, invalidChunks: 0, emptyRegionFiles: 0, issues: [] };
    for (const store of ['region', 'entities', 'poi']) {
      const storePath = path.join(relative, store); let entries;
      try { entries = fs.readdirSync(safePath(root, storePath), { withFileTypes: true }); }
      catch (error) { if (error.code !== 'ENOENT') dim.issues.push(`${storePath}: ${error.message}`); continue; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.name.endsWith('.mca')) continue;
        if (!entry.isFile() || !REGION_NAME.test(entry.name)) { dim.issues.push(`Skipped unsafe or unrecognized region: ${storePath}/${entry.name}`); continue; }
        requireThat(++regionTotal <= 20000, 'SCAN_LIMIT', 'World exceeds the v0.1 limit of 20,000 region files.');
        dim.stores[store]++;
        const file = path.join(storePath, entry.name);
        progress({ phase: 'Indexing regions', file, regions: regionTotal, chunks: chunkTotal });
        try {
          const region = inspectRegion(root, file, { includeChunks: store === 'region' });
          regionInventory.push({ path: file, store, dimension: key, ...region.sourceStamp });
          if (region.uninitialized) dim.emptyRegionFiles++;
          if (store === 'region') {
            dim.regions.push(region); dim.chunkCount += region.present; dim.invalidChunks += region.invalid; chunkTotal += region.present;
            requireThat(chunkTotal <= 1000000, 'SCAN_LIMIT', 'World exceeds the v0.1 limit of 1,000,000 terrain chunks.');
          } else for (const issue of region.issues) dim.issues.push(`${file}: ${issue}`);
        } catch (error) { if (error.code === 'SCAN_LIMIT') throw error; dim.issues.push(`${file}: ${error.message}`); if (store === 'region') { const match = REGION_NAME.exec(entry.name); dim.unreadableRegions.push({ rx: Number(match[1]), rz: Number(match[2]), message: error.message }); } }
      }
    }
    dimensions.push(dim);
  }
  function existsDirectory(relative) {
    try { return fs.statSync(safePath(root, relative)).isDirectory(); }
    catch (error) { if (error.code !== 'ENOENT') { const message = `${relative}: ${error.message}`; warn(message); validationErrors.push(message); } return false; }
  }
  // Legacy discovery is isolated so older format adapters can be added without changing the UI.
  for (const [id, relative] of [['minecraft:overworld', ''], ['minecraft:the_nether', 'DIM-1'], ['minecraft:the_end', 'DIM1']]) {
    if (['region', 'entities', 'poi'].some(store => existsDirectory(path.join(relative, store)))) addDimension(id, relative, 'legacy');
  }
  function walk(relative, parts, depth) {
    requireThat(++directoryTotal <= 10000 && depth <= 16, 'DIMENSION_LIMIT', 'Dimension directory traversal limit exceeded.');
    const entries = fs.readdirSync(safePath(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    if (parts.length >= 2 && (entries.some(e => ['region', 'entities', 'poi'].includes(e.name)) || (parts[0] === 'minecraft' && ['overworld', 'the_nether', 'the_end'].includes(parts.slice(1).join('/'))))) addDimension(`${parts[0]}:${parts.slice(1).join('/')}`, relative, 'namespaced');
    for (const entry of entries) {
      if (['region', 'entities', 'poi', 'data'].includes(entry.name)) continue;
      if (entry.isSymbolicLink()) { const message = `Skipped symbolic link: ${relative}/${entry.name}`; warn(message); validationErrors.push(message); continue; }
      if (entry.isDirectory()) walk(path.join(relative, entry.name), [...parts, entry.name], depth + 1);
    }
  }
  if (existsDirectory('dimensions')) walk('dimensions', [], 0);
  for (const dim of dimensions) if (dimensions.some(other => other !== dim && other.id === dim.id)) warn(`Multiple storage layouts found for ${dim.id}. They are shown separately and must not be merged automatically.`);
  if (!dimensions.length) warn('No dimension region folders found. This may be an empty or incomplete save.');
  const emptyRegionFiles = dimensions.reduce((n, d) => n + d.emptyRegionFiles, 0);
  if (emptyRegionFiles) warn(`${emptyRegionFiles} zero-byte region file(s) contain no saved records and are treated as empty, as Minecraft does. Inspection cannot determine whether they were previously populated.`);
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  const inventoryFingerprint = createHash('sha256').update(JSON.stringify({ fingerprint, generationFingerprint, regionInventory: regionInventory.sort((a, b) => a.path.localeCompare(b.path)), dimensions: dimensions.map(d => ({ key: d.key, issues: d.issues, regions: d.regions.map(r => ({ path: r.path, issues: r.issues })) })), validationErrors })).digest('hex');
  return { root, metadata, fingerprint, inventoryFingerprint, validationErrors, inspectedAt: new Date().toISOString(), dimensions, issues, capabilities, totals: { dimensions: dimensions.length, regions: regionTotal, chunks: chunkTotal, emptyRegionFiles, invalidChunks: dimensions.reduce((n, d) => n + d.invalidChunks, 0) } };
}
