import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { canonicalWorld, isWithin } from './paths.js';
import { requireThat } from './errors.js';

export function projectFilename(world) { return `${createHash('sha256').update(world.root).digest('hex')}.worldrenew.json`; }
export function validateProtection(world, protection) {
  requireThat(Array.isArray(protection) && protection.length <= 100000, 'PROJECT_LIMIT', 'Protection plan must contain at most 100,000 chunks.');
  const dims = new Map(world.dimensions.map(d => [d.key, new Set(d.regions.flatMap(r => r.chunks.map(c => `${c.x},${c.z}`)))]));
  const unique = new Map();
  for (const p of protection) {
    requireThat(p && typeof p.dimension === 'string' && Number.isSafeInteger(p.x) && Number.isSafeInteger(p.z), 'PROJECT_SCHEMA', 'Invalid protected chunk.');
    requireThat(dims.get(p.dimension)?.has(`${p.x},${p.z}`), 'PROJECT_CHUNK', 'Protected chunk does not exist in the current inspection.');
    unique.set(`${p.dimension}:${p.x},${p.z}`, { dimension: p.dimension, x: p.x, z: p.z });
  }
  return [...unique.values()];
}
export function projectDirectoryOutsideWorld(directory, world) {
  const root = canonicalWorld(world.root);
  // Check the closest existing ancestor before creating anything, including through aliases.
  let ancestor = path.resolve(directory), tail = [];
  while (!fs.existsSync(ancestor)) { tail.unshift(path.basename(ancestor)); const next = path.dirname(ancestor); requireThat(next !== ancestor, 'PROJECT_PATH', 'Invalid project directory.'); ancestor = next; }
  const resolved = path.join(fs.realpathSync(ancestor), ...tail);
  requireThat(!isWithin(root, resolved), 'PROJECT_IN_WORLD', 'WorldRenew project data must be outside the Minecraft save.');
  return resolved;
}
export function saveProject(directory, world, protection) {
  const data = { schemaVersion: 1, worldRoot: world.root, levelFingerprint: world.fingerprint, savedAt: new Date().toISOString(), protection: validateProtection(world, protection) };
  const safeDirectory = projectDirectoryOutsideWorld(directory, world);
  fs.mkdirSync(safeDirectory, { recursive: true });
  const file = path.join(safeDirectory, projectFilename(world)), temp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return { file, ...data };
}
export function loadProject(directory, world) {
  const file = path.join(projectDirectoryOutsideWorld(directory, world), projectFilename(world));
  if (!fs.existsSync(file)) return { protection: [], warnings: [] };
  const stat = fs.lstatSync(file);
  requireThat(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16 * 1024 * 1024, 'PROJECT_FILE', 'Unsafe or oversized project file.');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  requireThat(data.schemaVersion === 1 && data.worldRoot === world.root, 'PROJECT_SCHEMA', 'Project schema or world path does not match.');
  requireThat(Array.isArray(data.protection) && data.protection.length <= 100000, 'PROJECT_LIMIT', 'Invalid protection plan.');
  const warnings = [];
  if (data.levelFingerprint !== world.fingerprint) warnings.push('World metadata changed since this plan was saved. Review protection before future operations.');
  const protection = [];
  // Validate in one pass; stale entries are excluded with an explicit warning.
  const existing = new Set(world.dimensions.flatMap(d => d.regions.flatMap(r => r.chunks.map(c => `${d.key}:${c.x},${c.z}`))));
  for (const p of data.protection) {
    requireThat(p && typeof p.dimension === 'string' && Number.isSafeInteger(p.x) && Number.isSafeInteger(p.z), 'PROJECT_SCHEMA', 'Invalid protected chunk.');
    if (existing.has(`${p.dimension}:${p.x},${p.z}`)) protection.push(p);
    else if (!warnings.includes('Some protected chunks are no longer present and were excluded.')) warnings.push('Some protected chunks are no longer present and were excluded.');
  }
  return { protection: validateProtection(world, protection), warnings, file };
}
