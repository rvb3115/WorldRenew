import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { externalParent } from './build-archive.js';
import { safePath, isWithin } from './paths.js';
import { requireThat, WorldError } from './errors.js';

const MAX_JOURNAL = 1024 * 1024, MAX_MANIFEST = 64 * 1024 * 1024, MAX_ENTRIES = 200000;
const statuses = new Set(['backing-up', 'creating-working-copy', 'removing-records', 'validating', 'validated-test-copy', 'failed-working-copy-discarded']);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stamp = s => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String).join(':');
const identity = s => [s.dev, s.ino].map(String).join(':');
const stat = file => fs.lstatSync(file, { bigint: true });
const unavailable = message => { throw new WorldError('RECOVERY_UNAVAILABLE', message); };

// Accept either platform's manifest separators, but never reinterpret traversal,
// drive paths, alternate streams, ambiguous names or normalized aliases.
function relativePath(value) {
  requireThat(typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f:<>"|?*]/.test(value), 'RECOVERY_PATH', 'Invalid backup-relative path.');
  const parts = value.split(/[\\/]/);
  requireThat(parts.length <= 64 && parts.every(p => p && p !== '.' && p !== '..' && !/[. ]$/.test(p) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)), 'RECOVERY_PATH', 'Unsafe or non-portable backup-relative path.');
  return parts.join('/');
}
const localPath = relative => relative.split('/').join(path.sep);
function regular(file) {
  const s = stat(file);
  requireThat(s.isFile() && !s.isSymbolicLink(), 'RECOVERY_FILE', 'Recovery requires regular files; links and special files are refused.');
  return s;
}
function directory(folder) {
  const before = stat(folder);
  requireThat(before.isDirectory() && !before.isSymbolicLink(), 'RECOVERY_PATH', 'Choose a real transaction directory, not a symbolic link.');
  const root = fs.realpathSync(folder);
  requireThat(identity(stat(root)) === identity(before), 'RECOVERY_CHANGED', 'Transaction directory changed while opening it.');
  return root;
}
function readJSON(root, relative, maximum) {
  const file = safePath(root, localPath(relative)), before = regular(file);
  requireThat(before.size > 0n && before.size <= BigInt(maximum), 'RECOVERY_SIZE', 'Recovery metadata exceeds its size limit or is empty.');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    requireThat(stamp(fs.fstatSync(fd, { bigint: true })) === stamp(before), 'RECOVERY_CHANGED', 'Recovery metadata changed while opening it.');
    const bytes = Buffer.alloc(Number(before.size)); let position = 0;
    while (position < bytes.length) { const n = fs.readSync(fd, bytes, position, bytes.length - position, position); requireThat(n > 0, 'RECOVERY_CHANGED', 'Recovery metadata was truncated.'); position += n; }
    requireThat(stamp(fs.fstatSync(fd, { bigint: true })) === stamp(before) && stamp(regular(safePath(root, localPath(relative)))) === stamp(before), 'RECOVERY_CHANGED', 'Recovery metadata changed while reading it.');
    return { value: JSON.parse(bytes.toString('utf8')), sha256: hash(bytes), stamp: stamp(before) };
  } finally { fs.closeSync(fd); }
}
function validateJournal(j) {
  requireThat(j && j.schemaVersion === 1 && j.type === 'regeneration-copy' && uuid(j.id) && statuses.has(j.status) && hex(j.reviewDigest) && j.gameLoadTested === false, 'RECOVERY_JOURNAL', 'Unsupported or malformed regeneration journal.');
  requireThat(typeof j.source === 'string' && j.source.length <= 32768 && typeof j.adapter === 'string' && j.adapter.length <= 1024 && typeof j.updatedAt === 'string' && Number.isFinite(Date.parse(j.updatedAt)), 'RECOVERY_JOURNAL', 'Malformed regeneration journal metadata.');
  requireThat(j.result === null || typeof j.result === 'string' && relativePath(j.result) === 'result/world', 'RECOVERY_JOURNAL', 'Unexpected result pointer in regeneration journal.');
  // source and result are provenance only. Neither is ever resolved or opened.
  if (j.backup !== null) requireThat(typeof j.backup === 'string' && backupPointer(j.backup), 'RECOVERY_PATH', 'Journal backup pointer is not a recognized retained backup.');
}
const generatedCopy = name => /^WorldRenew-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/.test(name);
function backupPointer(value) {
  const parts = relativePath(value).split('/');
  return parts.length === 2 && parts[1] === 'world' && (parts[0] === 'backup' || generatedCopy(parts[0]));
}
function findBackup(root, journal) {
  if (journal.backup !== null) return relativePath(journal.backup);
  requireThat(journal.status === 'backing-up', 'RECOVERY_JOURNAL', 'Only the backing-up phase may omit its retained backup pointer.');
  // A crash can occur after the verified-copy rename but before journal update.
  // Never search result/, source paths or unfinished generic .partial copies.
  const candidates = []; let entries = 0;
  const dir = fs.opendirSync(root);
  try { let entry; while ((entry = dir.readSync())) {
    requireThat(++entries <= MAX_ENTRIES, 'RECOVERY_LIMIT', 'Transaction directory contains too many entries.');
    if (entry.name === 'backup' || generatedCopy(entry.name)) candidates.push(`${entry.name}/world`);
  } } finally { dir.closeSync(); }
  if (!candidates.length) unavailable('No completed retained backup was found. Partial copies are not treated as backups.');
  requireThat(candidates.length === 1, 'RECOVERY_AMBIGUOUS', 'Multiple possible backups were found; recovery will not guess.');
  return candidates[0];
}
function validateManifest(m) {
  requireThat(m && m.schemaVersion === 1 && m.algorithm === 'sha256' && uuid(m.id) && typeof m.source === 'string' && typeof m.createdAt === 'string' && Number.isFinite(Date.parse(m.createdAt)) && Array.isArray(m.files) && Array.isArray(m.directories), 'RECOVERY_MANIFEST', 'Unsupported or malformed backup manifest.');
  requireThat(m.operation === undefined && m.reviewDigest === undefined, 'RECOVERY_MANIFEST', 'A modified regeneration result manifest is not a retained backup manifest.');
  requireThat(m.files.length > 0 && m.files.length + m.directories.length <= MAX_ENTRIES && Number.isSafeInteger(m.bytes) && m.bytes >= 0, 'RECOVERY_LIMIT', 'Backup manifest inventory exceeds its limits.');
  const paths = new Map(), aliases = new Set();
  const add = (value, kind) => {
    const relative = relativePath(value), alias = relative.normalize('NFC').toLowerCase();
    requireThat(!paths.has(relative) && !aliases.has(alias), 'RECOVERY_MANIFEST', 'Duplicate or colliding backup paths.');
    paths.set(relative, kind); aliases.add(alias); return relative;
  };
  const directories = m.directories.map(value => add(value, 'directory')).sort();
  const files = m.files.map(f => {
    requireThat(f && Number.isSafeInteger(f.bytes) && f.bytes >= 0 && hex(f.sha256), 'RECOVERY_MANIFEST', 'Invalid backup file size or checksum.');
    return { path: add(f.path, 'file'), bytes: f.bytes, sha256: f.sha256 };
  }).sort((a, b) => a.path.localeCompare(b.path));
  for (const relative of paths.keys()) {
    const parent = relative.slice(0, relative.lastIndexOf('/'));
    if (relative.includes('/')) requireThat(paths.get(parent) === 'directory', 'RECOVERY_MANIFEST', 'Manifest omits a parent directory or nests below a file.');
  }
  const bytes = files.reduce((sum, f) => sum + f.bytes, 0);
  requireThat(Number.isSafeInteger(bytes) && bytes === m.bytes && paths.get('level.dat') === 'file', 'RECOVERY_MANIFEST', 'Backup manifest size or world metadata inventory is invalid.');
  return { directories, files, bytes };
}
function inventory(root) {
  const files = [], directories = [], aliases = new Set(); let count = 0;
  const rootStat = stat(root);
  requireThat(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'RECOVERY_PATH', 'Backup world must be a real directory.');
  function walk(relative, depth) {
    requireThat(depth <= 64, 'RECOVERY_LIMIT', 'Backup directory nesting limit exceeded.');
    const folder = relative ? safePath(root, localPath(relative)) : root, before = stat(folder), handle = fs.opendirSync(folder);
    try { let entry; while ((entry = handle.readSync())) {
      requireThat(++count <= MAX_ENTRIES, 'RECOVERY_LIMIT', 'Backup exceeds 200,000 filesystem entries.');
      requireThat(!/[\\/]/.test(entry.name), 'RECOVERY_PATH', 'Ambiguous filename in backup.');
      const rel = relativePath(relative ? `${relative}/${entry.name}` : entry.name), alias = rel.normalize('NFC').toLowerCase();
      requireThat(!aliases.has(alias), 'RECOVERY_PATH', 'Colliding paths in backup.'); aliases.add(alias);
      const s = stat(safePath(root, localPath(rel)));
      requireThat(!s.isSymbolicLink() && (s.isDirectory() || s.isFile()), 'RECOVERY_FILE', 'Backup contains a link or special file.');
      if (s.isDirectory()) { directories.push({ path: rel, stamp: stamp(s) }); walk(rel, depth + 1); }
      else { requireThat(s.size <= BigInt(Number.MAX_SAFE_INTEGER), 'RECOVERY_SIZE', 'Backup file is too large.'); files.push({ path: rel, bytes: Number(s.size), stamp: stamp(s) }); }
    } } finally { handle.closeSync(); }
    requireThat(stamp(stat(folder)) === stamp(before), 'RECOVERY_CHANGED', 'Backup directory changed during inspection.');
  }
  walk('', 0);
  requireThat(stamp(stat(root)) === stamp(rootStat), 'RECOVERY_CHANGED', 'Backup root changed during inspection.');
  return { rootStamp: stamp(rootStat), files: files.sort((a, b) => a.path.localeCompare(b.path)), directories: directories.sort((a, b) => a.path.localeCompare(b.path)) };
}
function assertTreeRoot(root, expectedStamp) {
  const s = stat(root);
  requireThat(s.isDirectory() && !s.isSymbolicLink() && stamp(s) === expectedStamp && fs.realpathSync(root) === root, 'RECOVERY_CHANGED', 'Backup world directory or an ancestor changed or became a symbolic link.');
}
function hashStable(root, file, rootStamp) {
  assertTreeRoot(root, rootStamp);
  const target = safePath(root, localPath(file.path)), before = regular(target);
  requireThat(stamp(before) === file.stamp, 'RECOVERY_CHANGED', `Backup file changed: ${file.path}`);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)), buffer = Buffer.alloc(1024 * 1024), digest = createHash('sha256');
  try {
    requireThat(stamp(fs.fstatSync(fd, { bigint: true })) === file.stamp, 'RECOVERY_CHANGED', 'Backup changed while opening a file.');
    let remaining = file.bytes;
    while (remaining > 0) { const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null); requireThat(n > 0, 'RECOVERY_CHANGED', 'Backup file was truncated while hashing.'); digest.update(buffer.subarray(0, n)); remaining -= n; }
    assertTreeRoot(root, rootStamp);
    requireThat(stamp(fs.fstatSync(fd, { bigint: true })) === file.stamp && stamp(regular(safePath(root, localPath(file.path)))) === file.stamp, 'RECOVERY_CHANGED', `Backup changed while hashing: ${file.path}`);
    return digest.digest('hex');
  } finally { fs.closeSync(fd); }
}
function verifyTree(root, manifest, progress = () => {}) {
  const before = inventory(root);
  requireThat(same(before.files.map(f => [f.path, f.bytes]), manifest.files.map(f => [f.path, f.bytes])) && same(before.directories.map(d => d.path).sort(), manifest.directories), 'RECOVERY_INVENTORY', 'Backup file or directory inventory does not match its manifest.');
  for (let i = 0; i < before.files.length; i++) {
    progress({ phase: 'Verifying retained backup', file: before.files[i].path, completed: i, total: before.files.length });
    requireThat(hashStable(root, before.files[i], before.rootStamp) === manifest.files[i].sha256, 'RECOVERY_HASH', `Backup checksum mismatch: ${before.files[i].path}`);
  }
  requireThat(same(inventory(root), before), 'RECOVERY_CHANGED', 'Backup changed during checksum verification.');
  return before;
}
function inspectDetailed(folder, progress) {
  const review = { directory: folder, status: 'unrecognized', backupState: 'invalid', recoverable: false, backup: null, files: 0, bytes: 0, reviewDigest: null, blockers: [], gameLoadTested: false };
  let progressError;
  const emit = event => { try { progress(event); } catch (error) { progressError = error; throw error; } };
  try {
    const root = directory(folder), rootIdentity = identity(stat(root)); review.directory = root;
    const journal = readJSON(root, 'operation.json', MAX_JOURNAL); validateJournal(journal.value); review.status = journal.value.status;
    const pointer = findBackup(root, journal.value); let backup, manifest;
    try {
      backup = safePath(root, localPath(pointer));
      manifest = readJSON(root, `${pointer.slice(0, -6)}/manifest.json`, MAX_MANIFEST);
    } catch (error) { if (error.code === 'ENOENT') unavailable('The retained backup or its completed manifest is missing.'); throw error; }
    const checked = validateManifest(manifest.value);
    requireThat(manifest.value.source === journal.value.source, 'RECOVERY_MANIFEST', 'Backup manifest provenance does not match the transaction journal.');
    const tree = verifyTree(backup, checked, emit);
    const journalAfter = readJSON(root, 'operation.json', MAX_JOURNAL), manifestAfter = readJSON(root, `${pointer.slice(0, -6)}/manifest.json`, MAX_MANIFEST);
    requireThat(rootIdentity === identity(stat(root)) && journal.sha256 === journalAfter.sha256 && journal.stamp === journalAfter.stamp && manifest.sha256 === manifestAfter.sha256 && manifest.stamp === manifestAfter.stamp, 'RECOVERY_CHANGED', 'Recovery journal or manifest changed during verification.');
    Object.assign(review, { backupState: 'verified', recoverable: true, backup, files: checked.files.length, bytes: checked.bytes,
      reviewDigest: hash(JSON.stringify({ root, rootIdentity, pointer, journal: [journal.sha256, journal.stamp], manifest: [manifest.sha256, manifest.stamp], tree })) });
    return { review, manifest: checked, tree };
  } catch (error) {
    if (error === progressError) throw error;
    review.backupState = error.code === 'RECOVERY_UNAVAILABLE' ? 'unavailable' : 'invalid';
    review.blockers.push(error.message); return { review };
  }
}

/** Read only: ignores source/result pointers and verifies only the retained backup. */
export function inspectRegenerationRecovery(folder, progress = () => {}) {
  return inspectDetailed(folder, progress).review;
}

function copyFile(root, target, file, expected, rootStamp) {
  assertTreeRoot(root, rootStamp);
  const original = safePath(root, localPath(file.path));
  requireThat(stamp(regular(original)) === file.stamp, 'RECOVERY_CHANGED', 'Backup changed before copying.');
  const input = fs.openSync(original, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); let output;
  try {
    requireThat(stamp(fs.fstatSync(input, { bigint: true })) === file.stamp, 'RECOVERY_CHANGED', 'Backup changed while opening it for copying.');
    const destination = path.join(target, localPath(file.path)), parent = path.dirname(destination);
    requireThat(directory(parent) === parent, 'RECOVERY_CHANGED', 'Recovery output parent changed.');
    output = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    const buffer = Buffer.alloc(1024 * 1024), digest = createHash('sha256'); let bytes = 0;
    while (bytes < file.bytes) {
      const n = fs.readSync(input, buffer, 0, Math.min(buffer.length, file.bytes - bytes), null); requireThat(n > 0, 'RECOVERY_CHANGED', 'Backup file was truncated during copying.');
      digest.update(buffer.subarray(0, n)); bytes += n;
      let offset = 0; while (offset < n) { const written = fs.writeSync(output, buffer, offset, n - offset, null); requireThat(written > 0, 'RECOVERY_WRITE', 'Incomplete recovery write.'); offset += written; }
    }
    fs.fsyncSync(output);
    assertTreeRoot(root, rootStamp);
    requireThat(bytes === file.bytes && digest.digest('hex') === expected.sha256 && stamp(fs.fstatSync(input, { bigint: true })) === file.stamp && stamp(regular(safePath(root, localPath(file.path)))) === file.stamp, 'RECOVERY_CHANGED', 'Backup changed during copying.');
  } finally { if (output !== undefined) fs.closeSync(output); fs.closeSync(input); }
}

/** Restore only into a fresh owned directory. No original or prior result is opened. */
export function createRecoveredRegenerationCopy(folder, expectedDigest, parent, { confirmedClosed = false, worlds = [] } = {}, progress = () => {}) {
  requireThat(confirmedClosed === true, 'WORLD_OPEN', 'Close Minecraft and all servers using the retained backup before recovery.');
  requireThat(hex(expectedDigest), 'RECOVERY_STALE', 'Inspect and verify the retained backup before recovery.');
  const checked = inspectDetailed(folder, progress), review = checked.review;
  requireThat(review.recoverable, 'RECOVERY_BLOCKED', review.blockers.join(' '));
  requireThat(review.reviewDigest === expectedDigest, 'RECOVERY_STALE', 'Recovery inputs changed. Inspect the retained backup again.');
  // The desktop supplies already-canonical open-world roots. Compare those
  // strings only; recovery must not inspect the original save to protect it.
  const output = externalParent(parent, [review.directory]);
  requireThat(Array.isArray(worlds) && worlds.every(root => typeof root === 'string' && path.isAbsolute(root)), 'RECOVERY_PATH', 'Invalid open-world destination boundary.');
  for (const root of worlds) requireThat(!isWithin(path.resolve(root), output), 'ARCHIVE_IN_WORLD', 'Choose a location outside every open Minecraft save.');
  const space = fs.statfsSync(output);
  requireThat(space.bavail * space.bsize > review.bytes + 16 * 1024 * 1024, 'COPY_SPACE', 'Insufficient space for a recovered copy and safety margin.');
  const id = randomUUID(), staging = path.join(output, `.WorldRenew-recovery-${id}.partial`), final = path.join(output, `WorldRenew-recovery-${id}`);
  fs.mkdirSync(staging, { mode: 0o700 }); const owned = identity(stat(staging)), target = path.join(staging, 'world');
  const stillOwned = () => { try { const s = stat(staging); return s.isDirectory() && !s.isSymbolicLink() && identity(s) === owned; } catch { return false; } };
  try {
    fs.mkdirSync(target, { mode: 0o700 });
    const targetIdentity = identity(stat(target));
    const assertOutput = () => requireThat(stillOwned() && directory(target) === target && identity(stat(target)) === targetIdentity, 'RECOVERY_CHANGED', 'Recovery staging or world directory changed.');
    progress({ phase: 'Recovery staging created', directory: staging });
    assertOutput();
    for (const relative of checked.manifest.directories.slice().sort((a, b) => a.split('/').length - b.split('/').length)) {
      assertOutput(); const parentRelative = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';
      if (parentRelative) safePath(target, localPath(parentRelative));
      fs.mkdirSync(path.join(target, localPath(relative)), { mode: 0o700 });
    }
    for (let i = 0; i < checked.tree.files.length; i++) {
      const file = checked.tree.files[i]; progress({ phase: 'Copying recovered backup', file: file.path, completed: i, total: checked.tree.files.length });
      assertOutput(); copyFile(review.backup, target, file, checked.manifest.files[i], checked.tree.rootStamp);
    }
    progress({ phase: 'Validating recovered backup copy', directory: staging });
    assertOutput();
    const fresh = inspectDetailed(review.directory, () => {}).review;
    requireThat(fresh.recoverable && fresh.reviewDigest === expectedDigest, 'RECOVERY_STALE', 'Retained backup or journal changed during recovery.');
    verifyTree(target, checked.manifest);
    const report = { schemaVersion: 1, type: 'regeneration-backup-recovery', id, status: 'verified-backup-copy', gameLoadTested: false,
      transaction: review.directory, transactionStatus: review.status, backup: review.backup, reviewDigest: expectedDigest,
      files: review.files, bytes: review.bytes, backupUnchanged: true, exactInventoryVerified: true, fileChecksumsVerified: true,
      note: 'Restored the retained backup only. No generation, version conversion or transaction-result reuse was performed.' };
    for (const [name, data] of [['recovery.json', report], ['manifest.json', { schemaVersion: 1, id, algorithm: 'sha256', source: review.backup, createdAt: new Date().toISOString(), ...checked.manifest }]]) {
      const fd = fs.openSync(path.join(staging, name), 'wx', 0o600); try { fs.writeFileSync(fd, JSON.stringify(data, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    requireThat(stillOwned() && !fs.existsSync(final), 'RECOVERY_CHANGED', 'Recovery destination changed before publication.');
    fs.renameSync(staging, final);
    return { directory: final, world: path.join(final, 'world'), report: path.join(final, 'recovery.json'), files: review.files, bytes: review.bytes, reviewDigest: expectedDigest, gameLoadTested: false };
  } catch (error) {
    // A replacement at our old pathname is not ours to delete.
    if (stillOwned()) fs.rmSync(staging, { recursive: true, force: true }); throw error;
  }
}
