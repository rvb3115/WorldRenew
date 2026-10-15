import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalWorld, isWithin } from './paths.js';
import { inspectWorld } from './world.js';
import { requireThat, WorldError } from './errors.js';

export function inventory(root) {
  const files = [], directories = []; let count = 0;
  function walk(relative, depth) {
    requireThat(depth <= 64, 'COPY_LIMIT', 'Copy directory nesting limit exceeded.');
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      requireThat(++count <= 200000, 'COPY_LIMIT', 'Copy exceeds 200,000 filesystem entries.');
      const rel = path.join(relative, entry.name), stat = fs.lstatSync(path.join(root, rel));
      requireThat(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile()), 'COPY_LINK', `Copy refuses links and special files: ${rel}`);
      if (stat.isDirectory()) { directories.push(rel); walk(rel, depth + 1); }
      else files.push({ path: rel, bytes: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino });
    }
  }
  walk('', 0); return { files, directories };
}
export function hashFile(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)), buffer = Buffer.alloc(1024 * 1024), hash = createHash('sha256');
  try { let n; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, n)); return hash.digest('hex'); }
  finally { fs.closeSync(fd); }
}
function assertCopyStructure(report) {
  const problems = [...(report.validationErrors ?? []), ...report.dimensions.flatMap(d => [...d.issues, ...d.regions.flatMap(r => r.issues)])];
  requireThat(report.totals.invalidChunks === 0 && problems.length === 0, 'COPY_VALIDATION', 'Structural validation failed. Copy creation is blocked; inspect the reported region errors first.');
}

/** Creates a separate byte-verified snapshot; never opens any source file for writing. */
export function createVerifiedCopy(source, parent, { confirmedClosed = false } = {}, progress = () => {}) {
  requireThat(confirmedClosed === true, 'WORLD_OPEN', 'Confirm Minecraft and any server using this save are fully closed.');
  const root = canonicalWorld(source), destinationParent = canonicalWorld(parent);
  requireThat(!isWithin(root, destinationParent), 'COPY_IN_WORLD', 'Choose a destination outside the source world.');
  for (let current = destinationParent; ; current = path.dirname(current)) {
    requireThat(!fs.existsSync(path.join(current, 'level.dat')), 'COPY_IN_WORLD', 'Copies cannot be stored inside a Minecraft save.');
    if (path.dirname(current) === current) break;
  }
  progress({ phase: 'Validating source' });
  assertCopyStructure(inspectWorld(root));
  const before = inventory(root), bytes = before.files.reduce((n, f) => n + f.bytes, 0);
  const space = fs.statfsSync(destinationParent);
  requireThat(space.bavail * space.bsize > bytes + 16 * 1024 * 1024, 'COPY_SPACE', 'Insufficient free space for a complete copy plus safety margin.');
  const id = randomUUID(), name = `WorldRenew-${new Date().toISOString().replace(/[:.]/g, '-')}-${id.slice(0, 8)}`;
  const staging = path.join(destinationParent, `.${name}.partial`), final = path.join(destinationParent, name), target = path.join(staging, 'world');
  fs.mkdirSync(staging, { mode: 0o700 });
  try {
    fs.mkdirSync(target);
    for (const directory of before.directories) fs.mkdirSync(path.join(target, directory), { recursive: true });
    const manifest = { schemaVersion: 1, id, source: root, createdAt: new Date().toISOString(), algorithm: 'sha256', bytes, directories: before.directories, files: [] };
    for (const file of before.files) {
      progress({ phase: 'Copying and verifying', file: file.path, completed: manifest.files.length, total: before.files.length });
      const original = path.join(root, file.path), copied = path.join(target, file.path), hash = hashFile(original);
      fs.copyFileSync(original, copied, fs.constants.COPYFILE_EXCL);
      requireThat(hashFile(copied) === hash && fs.statSync(copied).size === file.bytes, 'COPY_HASH', `Copy verification failed: ${file.path}`);
      manifest.files.push({ path: file.path, bytes: file.bytes, sha256: hash });
    }
    requireThat(JSON.stringify(inventory(root)) === JSON.stringify(before), 'COPY_CHANGED', 'Source changed while copying. Close Minecraft and try again.');
    // Rehash every source file after the copy, not only its timestamps.
    for (const file of manifest.files) requireThat(hashFile(path.join(root, file.path)) === file.sha256, 'COPY_CHANGED', `Source changed while copying: ${file.path}`);
    requireThat(JSON.stringify(inventory(root)) === JSON.stringify(before), 'COPY_CHANGED', 'Source changed during final verification.');
    progress({ phase: 'Validating copied world' });
    assertCopyStructure(inspectWorld(target));
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
    fs.renameSync(staging, final);
    return { directory: final, world: path.join(final, 'world'), manifest: path.join(final, 'manifest.json'), files: manifest.files.length, bytes };
  } catch (error) {
    // Only the unique staging directory created by this call can be removed.
    fs.rmSync(staging, { recursive: true, force: true }); throw error;
  }
}

/** General in-place mutation remains unavailable. Copy operations own separate transactions. */
export function executeDestructiveOperation() {
  throw new WorldError('WRITES_DISABLED', 'In-place world writes are disabled. Only restricted copy transactions may modify their own newly created working copies.');
}
