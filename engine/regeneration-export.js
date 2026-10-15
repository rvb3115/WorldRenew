import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRegenerationReview } from './regeneration.js';
import { createVerifiedCopy, hashFile, inventory } from './safety.js';
import { externalParent } from './build-archive.js';
import { inspectWorld } from './world.js';
import { inspectRegion } from './anvil.js';
import { safePath } from './paths.js';
import { requireThat } from './errors.js';

const slotOf = c => ((c.x % 32 + 32) % 32) + ((c.z % 32 + 32) % 32) * 32;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Stamps and the absolute world path necessarily change when copying; reviewed content must not.
function contentOf(review) {
  return { selection: review.selection, protection: review.protection, bufferChunks: review.bufferChunks,
    candidates: review.candidates, records: review.records, inputFiles: review.inputFiles,
    excludedProtected: review.excludedProtected, excludedBuffer: review.excludedBuffer,
    playerSafety: review.playerSafety, copyExport: review.copyExport };
}
function atomicJSON(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

// Calculate expected bytes independently from the writer, with bounded memory even for large regions.
function removedRegionHash(file, slots) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const header = Buffer.alloc(8192);
    requireThat(fs.readSync(fd, header, 0, header.length, null) === header.length, 'EXPORT_REGION', 'Incomplete region header.');
    for (const slot of slots) { header.fill(0, slot * 4, slot * 4 + 4); header.fill(0, 4096 + slot * 4, 4100 + slot * 4); }
    const hash = createHash('sha256').update(header), buffer = Buffer.alloc(1024 * 1024);
    let n; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, n));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

function verifyTree(root, manifest, overrides = new Map(), removed = new Set()) {
  const actual = inventory(root), expected = manifest.files.filter(f => !removed.has(f.path));
  requireThat(equal(actual.files.map(f => f.path).sort(), expected.map(f => f.path).sort()) &&
    equal(actual.directories.slice().sort(), manifest.directories.slice().sort()), 'EXPORT_FILES', 'World file or directory inventory changed unexpectedly.');
  const files = expected.map(file => {
    const sha256 = hashFile(safePath(root, file.path));
    requireThat(sha256 === (overrides.get(file.path) ?? file.sha256), 'EXPORT_HASH', `Unexpected world file change: ${file.path}`);
    return { ...file, sha256 };
  });
  requireThat(equal(inventory(root), actual), 'EXPORT_CHANGED', 'World changed during final validation.');
  return { ...manifest, files, bytes: files.reduce((sum, f) => sum + f.bytes, 0) };
}

/** Owns both newly-created copies. There is deliberately no caller-supplied writable world path. */
export function createRegeneratedCopy(world, review, parent, { confirmedClosed = false, confirmedExperimental = false } = {}, progress = () => {}) {
  requireThat(confirmedClosed === true, 'WORLD_OPEN', 'Close Minecraft and all servers using this world before exporting.');
  requireThat(confirmedExperimental === true, 'EXPORT_ACK', 'Review the selected removals and acknowledge that the exported test copy has not been game-load certified.');
  requireThat(review?.schemaVersion === 1 && review.executable === false && review.world?.root === world.root, 'REVIEW_SCHEMA', 'Preview the current world first.');
  const fresh = createRegenerationReview(world, review.selection, review.protection, { bufferChunks: review.bufferChunks }, progress);
  requireThat(fresh.reviewDigest === review.reviewDigest, 'REVIEW_STALE', 'Review inputs changed. Refresh the world and preview again.');
  requireThat(fresh.copyExport.eligible, 'EXPORT_BLOCKED', fresh.copyExport.blockers.join(' '));
  const output = externalParent(parent, [world.root]);
  const bytes = inventory(world.root).files.reduce((n, f) => n + f.bytes, 0), space = fs.statfsSync(output);
  requireThat(space.bavail * space.bsize > 2 * bytes + 32 * 1024 * 1024, 'COPY_SPACE', 'Insufficient free space for both a backup and a separate working copy.');
  const id = randomUUID(), stage = path.join(output, `.WorldRenew-regeneration-${id}.partial`), final = path.join(output, `WorldRenew-regeneration-${id}`);
  fs.mkdirSync(stage, { mode: 0o700 });
  let backup = null, working = null;
  const journal = (status, details = {}) => atomicJSON(path.join(stage, 'operation.json'), {
    schemaVersion: 1, type: 'regeneration-copy', id, status, source: world.root,
    reviewDigest: fresh.reviewDigest, adapter: fresh.copyExport.adapter,
    backup: backup ? path.relative(stage, backup.world) : null, result: status === 'validated-test-copy' ? 'result/world' : null,
    gameLoadTested: false, updatedAt: new Date().toISOString(), ...details
  });
  function label(copy, name) {
    const directory = path.join(stage, name); fs.renameSync(copy.directory, directory);
    return { ...copy, directory, world: path.join(directory, 'world'), manifest: path.join(directory, 'manifest.json') };
  }
  try {
    journal('backing-up'); atomicJSON(path.join(stage, 'review.json'), fresh);
    backup = createVerifiedCopy(world.root, stage, { confirmedClosed: true }, progress);
    backup = label(backup, 'backup');
    journal('creating-working-copy');
    working = createVerifiedCopy(backup.world, stage, { confirmedClosed: true }, progress);
    working = label(working, 'result');
    const copied = inspectWorld(working.world);
    const copiedReview = createRegenerationReview(copied, fresh.selection, fresh.protection, { bufferChunks: fresh.bufferChunks }, progress);
    requireThat(equal(contentOf(copiedReview), contentOf(fresh)), 'REVIEW_STALE', 'The backup differs from the reviewed inputs. Refresh and preview again.');
    const manifest = JSON.parse(fs.readFileSync(backup.manifest, 'utf8'));
    const regions = new Map(), removed = new Set(), overrides = new Map();
    for (const record of copiedReview.records) {
      if (record.status === 'absent') continue;
      requireThat(record.status === 'present', 'EXPORT_BLOCKED', 'Only validated records may be removed.');
      if (!regions.has(record.region)) regions.set(record.region, new Set());
      regions.get(record.region).add(slotOf(record));
      if (record.external) removed.add(record.sidecar);
    }
    journal('removing-records');
    for (const [relative, slots] of regions) {
      progress({ phase: 'Removing reviewed records from working copy', file: relative });
      const region = inspectRegion(working.world, relative);
      requireThat(!region.issues.length && [...slots].every(slot => region.chunks.some(c => slotOf(c) === slot && c.valid)), 'EXPORT_REGION', 'Working region is no longer valid.');
      overrides.set(relative, removedRegionHash(safePath(backup.world, relative), slots));
      const fd = fs.openSync(safePath(working.world, relative), fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
      try {
        const zero = Buffer.alloc(4);
        for (const slot of slots) {
          requireThat(fs.writeSync(fd, zero, 0, 4, slot * 4) === 4 && fs.writeSync(fd, zero, 0, 4, 4096 + slot * 4) === 4, 'EXPORT_WRITE', 'Incomplete region header write.');
        }
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
    }
    for (const relative of removed) fs.unlinkSync(safePath(working.world, relative));
    journal('validating'); progress({ phase: 'Validating regeneration copy', file: working.world });
    const result = inspectWorld(working.world);
    requireThat(!result.validationErrors.length && result.dimensions.every(d => !d.issues.length && d.regions.every(r => !r.issues.length)), 'EXPORT_VALIDATION', 'Output structural validation failed.');
    requireThat(result.totals.chunks === copied.totals.chunks - fresh.candidates.length, 'EXPORT_VALIDATION', 'Unexpected number of remaining terrain records.');
    const outputManifest = verifyTree(working.world, manifest, overrides, removed);
    verifyTree(backup.world, manifest); verifyTree(world.root, manifest);
    // Replace the pre-edit copy manifest so it accurately describes the delivered result.
    atomicJSON(working.manifest, { ...outputManifest, source: world.root, operation: id, reviewDigest: fresh.reviewDigest });
    atomicJSON(path.join(stage, 'validation.json'), {
      schemaVersion: 1, status: 'validated-test-copy', gameLoadTested: false, adapter: fresh.copyExport.adapter,
      reviewDigest: fresh.reviewDigest, removedChunks: fresh.candidates, protectedChunks: fresh.protection,
      bufferChunks: fresh.bufferChunks, modifiedRegions: [...regions.keys()], removedSidecars: [...removed],
      unchangedFilesVerified: true, untouchedRegionBytesVerified: true, sourceAndBackupVerified: true,
      playerSafety: fresh.playerSafety, playerFilesByteIdentical: true,
      warnings: [...fresh.warnings, 'Experimental export: OS locking, crash recovery and Minecraft game-load certification remain pending. Keep Minecraft closed for the whole operation.']
    });
    journal('validated-test-copy'); fs.renameSync(stage, final);
    return { directory: final, world: path.join(final, 'result/world'), backup: path.join(final, 'backup/world'),
      report: path.join(final, 'validation.json'), removedChunks: fresh.candidates.length };
  } catch (error) {
    // Never clean up user paths or the verified backup. Only this call's working copy is disposable.
    if (working) fs.rmSync(working.directory, { recursive: true, force: true });
    if (backup) {
      try { journal('failed-working-copy-discarded', { error: error.message }); } catch { /* Preserve original failure and backup on disk-full errors. */ }
      error.message += ` Verified backup retained at ${backup.world}`;
    } else fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}
