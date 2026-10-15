import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { decodeDat, NBT_LIMITS } from './nbt.js';
import { readBounded, safePath } from './paths.js';
import { requireThat } from './errors.js';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const stringList = value => Array.isArray(value) && value.every(s => typeof s === 'string');
const FIELDS = ['enabled_features', 'removed_features', 'DataPacks'];
/** Read evidence, not an experiment-history detector. WasModded has no role here. */
export function configurationSummary(data, generation, generationSource = null) {
  const present = field => Object.hasOwn(data, field);
  const enabled = stringList(data.enabled_features) ? [...data.enabled_features] : null;
  const removed = stringList(data.removed_features) ? [...data.removed_features] : null;
  const packs = data.DataPacks;
  const enabledPacks = stringList(packs?.Enabled) ? [...packs.Enabled] : null;
  const disabledPacks = stringList(packs?.Disabled) ? [...packs.Disabled] : null;
  const settings = [];
  if (generation?.dimensions && typeof generation.dimensions === 'object') for (const [id, dimension] of Object.entries(generation.dimensions).slice(0, 100)) {
    const value = dimension?.generator?.settings;
    settings.push({ dimension: id, generator: typeof dimension?.generator?.type === 'string' ? dimension.generator.type : null,
      settings: typeof value === 'string' ? value : value && typeof value === 'object' ? 'Inline settings (not interpreted)' : null });
  }
  const notices = [];
  if (enabled?.some(flag => flag !== 'minecraft:vanilla')) notices.push(`Recorded enabled feature flags: ${enabled.join(', ')}. Supported reads and copies remain available; individual block/schema adapters determine rewrite support.`);
  if (removed?.length) notices.push(`Recorded removed feature flags: ${removed.join(', ')}. This is preserved evidence, not a complete experiment history.`);
  if (enabledPacks?.some(pack => pack !== 'vanilla')) notices.push('Enabled datapacks are recorded. World copies preserve pack files/configuration; a build template does not install packs in another world.');
  for (const field of FIELDS) if (present(field) && (field === 'DataPacks' ? !enabledPacks || !disabledPacks : !stringList(data[field]))) notices.push(`${field} has an unrecognized shape. It is preserved without inferring defaults.`);
  return { enabledFeatures: enabled, removedFeatures: removed, enabledPacks, disabledPacks, featureHistory: 'Unknown: absent/current flags cannot establish past experiments.',
    generationSource, generateStructures: typeof generation?.generate_structures === 'number' ? generation.generate_structures : typeof generation?.generate_features === 'number' ? generation.generate_features : null,
    generatorSettings: settings, notices };
}
/** Bounded content fingerprint for a rewrite review, never pack evaluation or installation. */
export function readWorldConfiguration(root, { fingerprintPacks = true } = {}) {
  const bytes = readBounded(root, 'level.dat', NBT_LIMITS.compressed), data = decodeDat(bytes).Data;
  requireThat(data && typeof data === 'object', 'CONFIGURATION_SCHEMA', 'World configuration has no Data compound.');
  const fields = Object.fromEntries(FIELDS.filter(k => Object.hasOwn(data, k)).map(k => [k, data[k]]));
  let generation = data.WorldGenSettings, generationSource = generation ? 'level.dat:Data.WorldGenSettings' : null;
  const inputs = [{ path: 'level.dat', sha256: hash(bytes) }];
  const generationPath = 'data/minecraft/world_gen_settings.dat';
  try {
    const packed = readBounded(root, generationPath, NBT_LIMITS.compressed), parsed = decodeDat(packed);
    generation = parsed.data ?? parsed.Data ?? parsed; generationSource = generationPath;
    inputs.push({ path: generationPath, sha256: hash(packed) });
  } catch (error) { if (error.code !== 'ENOENT') throw error; inputs.push({ path: generationPath, sha256: null }); }
  let entries = 0, total = 0;
  const packFiles = [];
  function walk(relative, depth) {
    requireThat(depth <= 32, 'CONFIGURATION_LIMIT', 'Datapack review exceeds 32 directory levels; this rewrite cannot establish a bounded configuration snapshot.');
    for (const entry of fs.readdirSync(safePath(root, relative), { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      requireThat(++entries <= 10000, 'CONFIGURATION_LIMIT', 'Datapack review exceeds 10,000 entries; this rewrite cannot establish a bounded configuration snapshot.');
      const rel = path.join(relative, entry.name);
      requireThat(!entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory()), 'CONFIGURATION_FILE', 'Datapack review refuses links and special files.');
      if (entry.isDirectory()) { walk(rel, depth + 1); continue; }
      const size = fs.statSync(safePath(root, rel)).size; total += size;
      requireThat(size <= 64 * 1024 * 1024 && total <= 256 * 1024 * 1024, 'CONFIGURATION_LIMIT', 'Datapack review supports files up to 64 MiB and 256 MiB total; read-only inspection and byte-preserving copy remain separate operations.');
      packFiles.push({ path: rel.split(path.sep).join('/'), sha256: hash(readBounded(root, rel, 64 * 1024 * 1024)) });
    }
  }
  if (fingerprintPacks) {
    let exists = true;
    try { safePath(root, 'datapacks'); } catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; }
    if (exists) walk('datapacks', 0);
  }
  const summary = configurationSummary(data, generation, generationSource);
  const provenance = { schema: 1, fields, generationSource, generationSha256: inputs.find(i => i.path === generationPath)?.sha256 ?? null, generatorSettings: summary.generatorSettings, packFiles: fingerprintPacks ? packFiles : null };
  requireThat(Buffer.byteLength(JSON.stringify(provenance)) <= 1024 * 1024, 'CONFIGURATION_LIMIT', 'Configuration provenance exceeds the 1 MiB limit.');
  return { provenance, summary, digest: hash(Buffer.from(JSON.stringify({ inputs, packFiles }))) };
}
export function validateConfigurationProvenance(value) {
  requireThat(value && value.schema === 1 && value.fields && typeof value.fields === 'object' && !Array.isArray(value.fields) && Buffer.byteLength(JSON.stringify(value)) <= 1024 * 1024, 'ARCHIVE_CONFIGURATION', 'Invalid or oversized template configuration provenance.');
  // Optional provenance is retained as data; it never installs flags or datapacks.
  return value;
}
