import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { projectDirectoryOutsideWorld } from './projects.js';
import { validateBounds } from './volumes.js';
import { requireThat } from './errors.js';
const filename = world => `${createHash('sha256').update(world.root).digest('hex')}.selections.json`;
export function loadSelections(directory, world) {
  const file = path.join(projectDirectoryOutsideWorld(directory, world), filename(world));
  if (!fs.existsSync(file)) return [];
  const stat = fs.lstatSync(file);
  requireThat(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024*1024, 'SELECTION_FILE', 'Unsafe or oversized selection library.');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  requireThat(data.schemaVersion === 1 && data.worldRoot === world.root && Array.isArray(data.selections) && data.selections.length <= 100, 'SELECTION_SCHEMA', 'Invalid selection library.');
  return data.selections.map(s => {
    requireThat(typeof s.id === 'string' && typeof s.name === 'string' && s.name.length <= 80 && typeof s.dimension === 'string' && typeof s.digest === 'string', 'SELECTION_SCHEMA', 'Invalid saved selection.');
    return { id:s.id, name:s.name, dimension:s.dimension, bounds:validateBounds(s.bounds).bounds, digest:s.digest, savedAt:s.savedAt };
  });
}
export function saveSelection(directory, world, volume, name) {
  requireThat(typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 80, 'SELECTION_NAME', 'Give the selection a name (1–80 characters).');
  requireThat(volume?.root === world.root && world.dimensions.some(d=>d.key===volume.dimension) && volume.complete, 'SELECTION_CAPTURE', 'Scan a complete selection in this world before saving.');
  const selections = loadSelections(directory, world);
  requireThat(selections.length < 100, 'SELECTION_LIMIT', 'This world already has 100 saved selections.');
  const entry = { id:randomUUID(), name:name.trim(), dimension:volume.dimension, bounds:validateBounds(volume.bounds).bounds, digest:volume.digest, savedAt:new Date().toISOString() };
  selections.push(entry);
  const safe = projectDirectoryOutsideWorld(directory, world); fs.mkdirSync(safe, {recursive:true});
  const file = path.join(safe, filename(world)), temp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify({schemaVersion:1, worldRoot:world.root, selections},null,2),{flag:'wx',mode:0o600}); fs.renameSync(temp,file); }
  finally { if(fs.existsSync(temp))fs.unlinkSync(temp); }
  return {file, entry, selections};
}
