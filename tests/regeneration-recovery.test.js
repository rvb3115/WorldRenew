import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { makeWorld } from './fixtures.js';
import { inspectWorld } from '../engine/world.js';
import { createRegenerationReview } from '../engine/regeneration.js';
import { createRegeneratedCopy } from '../engine/regeneration-export.js';
import { inspectRegenerationRecovery, createRecoveredRegenerationCopy } from '../engine/regeneration-recovery.js';
import { hashFile, inventory } from '../engine/safety.js';

const acknowledgement = { confirmedClosed: true, confirmedExperimental: true };
const read = file => JSON.parse(fs.readFileSync(file));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const content = root => { const i = inventory(root); return { directories: i.directories.sort(), files: i.files.map(f => [f.path, f.bytes, hashFile(path.join(root, f.path))]) }; };
function fixture(t, { exportCopy = true } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worldrenew-recovery-'))); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = makeWorld(path.join(base, 'source'), { dataVersion: 5023, spawn: [1024, 64, 1024] });
  fs.mkdirSync(path.join(source, 'datapacks', 'empty'), { recursive: true }); fs.writeFileSync(path.join(source, 'opaque.dat'), Buffer.from([0, 1, 255, 17]));
  const world = inspectWorld(source), dimension = world.dimensions.find(d => d.id === 'minecraft:overworld').key;
  const plan = createRegenerationReview(world, [{ x: 0, z: 0, dimension }], [], { bufferChunks: 0 });
  const result = exportCopy ? createRegeneratedCopy(world, plan, base, acknowledgement) : {};
  return { base, source, world, plan, ...result, journal: result.directory && path.join(result.directory, 'operation.json'), manifest: result.backup && path.join(path.dirname(result.backup), 'manifest.json') };
}
function editJournal(f, changes) { write(f.journal, { ...read(f.journal), ...changes }); }
function editManifest(f, change) { const value = read(f.manifest); change(value); write(f.manifest, value); }
function recovered(f, review = inspectRegenerationRecovery(f.directory), progress) { return createRecoveredRegenerationCopy(f.directory, review.reviewDigest, f.base, { confirmedClosed: true }, progress); }
function noRecoveryOutputs(f) { assert.equal(fs.readdirSync(f.base).some(n => /WorldRenew-recovery-/.test(n)), false); }

test('completed transaction recovers exact backup bytes and empty directories into a fresh copy', t => {
  const f = fixture(t), original = content(f.source), backup = content(f.backup), retained = content(f.directory);
  const review = inspectRegenerationRecovery(f.directory);
  assert.equal(review.recoverable, true); assert.equal(review.backupState, 'verified'); assert.equal(review.status, 'validated-test-copy'); assert.equal(review.gameLoadTested, false);
  const output = recovered(f, review);
  assert.deepEqual(content(output.world), backup); assert.deepEqual(content(f.source), original); assert.deepEqual(content(f.directory), retained);
  const report = read(output.report); assert.equal(report.backupUnchanged, true); assert.equal(report.gameLoadTested, false); assert.equal(report.fileChecksumsVerified, true);
  assert.notDeepEqual(content(f.source), content(f.directory + '/result/world'));
  assert.ok(!output.directory.includes('.partial')); assert.equal(fs.readdirSync(f.base).some(n => n.startsWith('.WorldRenew-recovery-')), false);
  const second = recovered(f, review); assert.notEqual(second.directory, output.directory); assert.deepEqual(content(second.world), backup);
});

test('each known interrupted stage is inspectable without opening source or result pointers', t => {
  const f = fixture(t), initial = content(f.backup), open = fs.openSync, lstat = fs.lstatSync;
  const source = f.source, result = path.join(f.directory, 'result');
  fs.rmSync(source, { recursive: true }); fs.rmSync(result, { recursive: true }); fs.symlinkSync('/unreadable-original-must-not-be-opened', result);
  const forbidden = value => typeof value === 'string' && (value === source || value.startsWith(source + path.sep) || value === result || value.startsWith(result + path.sep));
  t.mock.method(fs, 'openSync', (file, ...args) => { assert.equal(forbidden(file), false, `opened forbidden path ${file}`); return open(file, ...args); });
  t.mock.method(fs, 'lstatSync', (file, ...args) => { assert.equal(forbidden(file), false, `inspected forbidden path ${file}`); return lstat(file, ...args); });
  for (const status of ['creating-working-copy', 'removing-records', 'validating', 'failed-working-copy-discarded']) {
    editJournal(f, { status, result: null });
    const review = inspectRegenerationRecovery(f.directory); assert.equal(review.status, status); assert.equal(review.recoverable, true);
    assert.deepEqual(content(createRecoveredRegenerationCopy(f.directory, review.reviewDigest, f.base, { confirmedClosed: true, worlds: [source] }).world), initial);
  }
});

test('existing failed backup-label transaction remains recoverable', t => {
  const f = fixture(t, { exportCopy: false }), rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => { if (path.basename(to) === 'backup') throw new Error('backup label failed'); return rename(from, to); });
  assert.throws(() => createRegeneratedCopy(f.world, f.plan, f.base, acknowledgement), /Verified backup retained/); t.mock.restoreAll();
  f.directory = path.join(f.base, fs.readdirSync(f.base).find(n => n.endsWith('.partial')));
  const review = inspectRegenerationRecovery(f.directory); assert.equal(review.status, 'failed-working-copy-discarded'); assert.equal(review.recoverable, true);
  assert.match(review.backup, /WorldRenew-\d{4}.*\/world$/); assert.deepEqual(content(recovered(f, review).world), content(f.source));
});

test('unambiguous completed backup discovered after crash between label and journal update', t => {
  const f = fixture(t); editJournal(f, { status: 'backing-up', backup: null, result: null });
  assert.equal(inspectRegenerationRecovery(f.directory).recoverable, true);
  const generated = 'WorldRenew-2026-10-16T12-00-00-000Z-1234abcd'; fs.renameSync(path.dirname(f.backup), path.join(f.directory, generated));
  const review = inspectRegenerationRecovery(f.directory); assert.equal(review.recoverable, true); assert.ok(review.backup.includes(generated));
  fs.mkdirSync(path.join(f.directory, 'backup')); assert.equal(inspectRegenerationRecovery(f.directory).recoverable, false);
});

test('null backup pointers in later phases are blocked instead of discovering another copy', t => {
  const f = fixture(t);
  for (const status of ['creating-working-copy', 'removing-records', 'validating', 'validated-test-copy', 'failed-working-copy-discarded']) {
    editJournal(f, { status, backup: null }); assert.equal(inspectRegenerationRecovery(f.directory).recoverable, false);
  }
});

test('missing and incomplete backups are unavailable; partial copy directories are never guessed', t => {
  const f = fixture(t); fs.rmSync(path.dirname(f.backup), { recursive: true });
  let review = inspectRegenerationRecovery(f.directory); assert.equal(review.backupState, 'unavailable'); assert.equal(review.reviewDigest, null);
  fs.mkdirSync(f.backup, { recursive: true }); fs.writeFileSync(path.join(f.backup, 'level.dat'), 'partial');
  assert.equal(inspectRegenerationRecovery(f.directory).backupState, 'unavailable');
  fs.renameSync(path.dirname(f.backup), path.join(f.directory, '.WorldRenew-unfinished.partial')); editJournal(f, { backup: null, status: 'backing-up', result: null });
  review = inspectRegenerationRecovery(f.directory); assert.equal(review.backupState, 'unavailable'); assert.equal(review.recoverable, false);
});

test('Windows relative separators normalize without changing recovered paths', t => {
  const f = fixture(t); editJournal(f, { backup: 'backup\\world', result: 'result\\world' });
  editManifest(f, m => { m.directories = m.directories.map(p => p.replaceAll('/', '\\')); for (const file of m.files) file.path = file.path.replaceAll('/', '\\'); });
  const review = inspectRegenerationRecovery(f.directory); assert.equal(review.recoverable, true); assert.deepEqual(content(recovered(f, review).world), content(f.source));
});

test('swapped provenance and known regeneration-result manifests cannot become backups', t => {
  const f = fixture(t), original = read(f.manifest);
  editManifest(f, m => m.source = '/another-original-world'); assert.equal(inspectRegenerationRecovery(f.directory).recoverable, false);
  write(f.manifest, original); fs.rmSync(f.backup, { recursive: true }); fs.cpSync(path.join(f.directory, 'result', 'world'), f.backup, { recursive: true });
  fs.copyFileSync(path.join(f.directory, 'result', 'manifest.json'), f.manifest);
  const review = inspectRegenerationRecovery(f.directory); assert.equal(review.recoverable, false); assert.match(review.blockers.join(' '), /result manifest/);
});

for (const backup of ['../source', '/tmp/world', 'C:\\world', '\\\\server\\share', 'backup/../result/world', 'result/world', 'backup/world/child', 'backup:stream/world', 'backup//world']) test(`unsafe backup pointer rejected: ${backup}`, t => {
  const f = fixture(t); editJournal(f, { backup }); const review = inspectRegenerationRecovery(f.directory); assert.equal(review.recoverable, false); assert.equal(review.backupState, 'invalid'); noRecoveryOutputs(f);
});

test('journal schema, type, status, metadata and JSON budgets fail closed', t => {
  const f = fixture(t), journal = read(f.journal);
  for (const patch of [{ schemaVersion: 2 }, { type: 'other' }, { status: 'finished' }, { id: 'bad' }, { reviewDigest: 'bad' }, { gameLoadTested: true }, { source: {} }, { result: '../source' }]) {
    write(f.journal, { ...journal, ...patch }); assert.equal(inspectRegenerationRecovery(f.directory).recoverable, false);
  }
  fs.writeFileSync(f.journal, '{broken'); assert.equal(inspectRegenerationRecovery(f.directory).recoverable, false);
  fs.writeFileSync(f.journal, Buffer.alloc(1024 * 1024 + 1, 32)); assert.equal(inspectRegenerationRecovery(f.directory).recoverable, false);
});

test('malformed, duplicate, aliasing, traversing and incomplete manifest inventories fail closed', t => {
  const f = fixture(t), manifest = read(f.manifest);
  const mutations = [m => m.schemaVersion = 2, m => m.algorithm = 'md5', m => m.bytes++, m => m.files[0].sha256 = 'bad', m => m.files[0].bytes = -1,
    m => m.files.push({ ...m.files[0] }), m => m.files.push({ ...m.files[0], path: m.files[0].path.toUpperCase() }),
    m => m.files[0].path = '../outside', m => m.files[0].path = 'C:\\outside', m => m.files[0].path = 'level.dat:alternate',
    ...['<', '>', '"', '|', '?', '*', '\x7f'].map(char => m => m.files[0].path = `invalid${char}name`),
    m => m.directories.shift(), m => m.files = m.files.filter(f => f.path !== 'level.dat'), m => m.directories.push('unlisted-empty')];
  for (const change of mutations) { const m = structuredClone(manifest); change(m); write(f.manifest, m); assert.equal(inspectRegenerationRecovery(f.directory).recoverable, false); }
  fs.writeFileSync(f.manifest, Buffer.alloc(64 * 1024 * 1024 + 1)); assert.equal(inspectRegenerationRecovery(f.directory).recoverable, false);
});

for (const kind of ['changed-bytes', 'missing-file', 'extra-file', 'extra-directory', 'missing-empty-directory']) test(`manifest verification rejects ${kind}`, t => {
  const f = fixture(t), file = path.join(f.backup, 'opaque.dat');
  if (kind === 'changed-bytes') fs.writeFileSync(file, Buffer.from([1, 1, 255, 17]));
  if (kind === 'missing-file') fs.unlinkSync(file);
  if (kind === 'extra-file') fs.writeFileSync(path.join(f.backup, 'extra'), 'extra');
  if (kind === 'extra-directory') fs.mkdirSync(path.join(f.backup, 'extra'));
  if (kind === 'missing-empty-directory') fs.rmdirSync(path.join(f.backup, 'datapacks', 'empty'));
  const review = inspectRegenerationRecovery(f.directory); assert.equal(review.backupState, 'invalid'); assert.equal(review.recoverable, false);
});

test('symlinks at transaction, metadata, backup or nested-file paths are never followed', t => {
  const f = fixture(t), alias = path.join(f.base, 'alias'); fs.symlinkSync(f.directory, alias);
  assert.equal(inspectRegenerationRecovery(alias).recoverable, false);
  for (const target of [f.journal, f.manifest, path.join(f.backup, 'opaque.dat'), path.join(f.backup, 'datapacks'), f.backup]) {
    fs.renameSync(target, target + '.original'); fs.symlinkSync(target + '.original', target);
    assert.equal(inspectRegenerationRecovery(f.directory).recoverable, false, target); fs.unlinkSync(target); fs.renameSync(target + '.original', target);
  }
});

test('special files are rejected without opening or blocking on them', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), fifo = path.join(f.backup, 'fifo'); assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  assert.equal(inspectRegenerationRecovery(f.directory).recoverable, false);
});

test('restoration requires acknowledgement, unchanged retained digest and external destination', t => {
  const f = fixture(t), review = inspectRegenerationRecovery(f.directory);
  assert.throws(() => createRecoveredRegenerationCopy(f.directory, review.reviewDigest, f.base), { code: 'WORLD_OPEN' });
  assert.throws(() => createRecoveredRegenerationCopy(f.directory, '0'.repeat(64), f.base, { confirmedClosed: true }), { code: 'RECOVERY_STALE' });
  for (const parent of [f.directory, f.backup, f.source]) assert.throws(() => createRecoveredRegenerationCopy(f.directory, review.reviewDigest, parent, { confirmedClosed: true }), { code: 'ARCHIVE_IN_WORLD' });
  fs.mkdirSync(path.join(f.base, 'other')); const other = fs.realpathSync(path.join(f.base, 'other'));
  assert.throws(() => createRecoveredRegenerationCopy(f.directory, review.reviewDigest, other, { confirmedClosed: true, worlds: [other] }), { code: 'ARCHIVE_IN_WORLD' });
  editJournal(f, { status: 'validating', result: null }); assert.throws(() => recovered(f, review), { code: 'RECOVERY_STALE' }); noRecoveryOutputs(f);
});

test('replacing identical manifest or backup bytes invalidates an old review', t => {
  const f = fixture(t); let review = inspectRegenerationRecovery(f.directory);
  const bytes = fs.readFileSync(f.manifest); fs.unlinkSync(f.manifest); fs.writeFileSync(f.manifest, bytes);
  assert.throws(() => recovered(f, review), { code: 'RECOVERY_STALE' });
  review = inspectRegenerationRecovery(f.directory); const file = path.join(f.backup, 'opaque.dat'), b = fs.readFileSync(file); fs.unlinkSync(file); fs.writeFileSync(file, b);
  assert.throws(() => recovered(f, review), { code: 'RECOVERY_STALE' }); noRecoveryOutputs(f);
});

test('inspection detects file and directory replacement from progress callbacks', t => {
  const f = fixture(t); let changed = false;
  const review = inspectRegenerationRecovery(f.directory, () => { if (!changed) { changed = true; fs.writeFileSync(path.join(f.backup, 'opaque.dat'), 'bad'); } });
  assert.equal(review.recoverable, false); assert.equal(review.backupState, 'invalid');
});

test('concurrently growing backup files are read only to their reviewed byte length', t => {
  for (const mode of ['inspect', 'copy']) {
    const f = fixture(t), review = inspectRegenerationRecovery(f.directory), file = path.join(f.backup, 'opaque.dat');
    const open = fs.openSync, readSync = fs.readSync; let tracked, bytes = 0, reads = 0, armed = mode === 'inspect';
    t.mock.method(fs, 'openSync', (name, ...args) => { const fd = open(name, ...args); if (armed && name === file) tracked = fd; return fd; });
    t.mock.method(fs, 'readSync', (fd, ...args) => { const n = readSync(fd, ...args); if (fd === tracked) { bytes += n; reads++; fs.appendFileSync(file, Buffer.alloc(1024)); } return n; });
    if (mode === 'inspect') assert.equal(inspectRegenerationRecovery(f.directory).recoverable, false);
    else assert.throws(() => recovered(f, review, p => { if (p.phase === 'Copying recovered backup') armed = true; }));
    t.mock.restoreAll(); assert.equal(bytes, 4); assert.equal(reads, 1); noRecoveryOutputs(f);
  }
});

test('backup root symlink substitution is rejected before following it in inspection or copying', t => {
  for (const mode of ['inspect', 'copy']) for (const ancestor of [false, true]) {
    const f = fixture(t), review = inspectRegenerationRecovery(f.directory), open = fs.openSync; let changed = false;
    t.mock.method(fs, 'openSync', (file, ...args) => { assert.equal(changed && typeof file === 'string' && file.startsWith(f.backup + path.sep), false, 'must not open a path through replaced backup root'); return open(file, ...args); });
    const progress = p => {
      if (changed || p.phase !== (mode === 'inspect' ? 'Verifying retained backup' : 'Copying recovered backup')) return;
      const replaced = ancestor ? path.dirname(f.backup) : f.backup;
      fs.renameSync(replaced, replaced + '-moved'); fs.symlinkSync(replaced + '-moved', replaced); changed = true;
    };
    if (mode === 'inspect') assert.equal(inspectRegenerationRecovery(f.directory, progress).recoverable, false);
    else assert.throws(() => recovered(f, review, progress));
    assert.equal(changed, true); t.mock.restoreAll(); noRecoveryOutputs(f);
  }
});

test('cancellation before and during copying preserves retained transaction and removes only own staging', t => {
  const f = fixture(t), before = content(f.directory), review = inspectRegenerationRecovery(f.directory), error = new Error('cancelled');
  assert.throws(() => inspectRegenerationRecovery(f.directory, () => { throw error; }), error);
  for (const phase of ['Recovery staging created', 'Copying recovered backup', 'Validating recovered backup copy']) {
    assert.throws(() => recovered(f, review, p => { if (p.phase === phase) throw error; }), error); noRecoveryOutputs(f); assert.deepEqual(content(f.directory), before);
  }
});

test('copy I/O failure and insufficient space leave retained backup untouched', t => {
  const f = fixture(t), before = content(f.directory), review = inspectRegenerationRecovery(f.directory), writeSync = fs.writeSync; let copying = false;
  t.mock.method(fs, 'writeSync', (...args) => { if (copying) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return writeSync(...args); });
  assert.throws(() => recovered(f, review, p => { if (p.phase === 'Copying recovered backup') copying = true; }), { code: 'ENOSPC' });
  t.mock.restoreAll(); noRecoveryOutputs(f); assert.deepEqual(content(f.directory), before);
  t.mock.method(fs, 'statfsSync', () => ({ bavail: 0, bsize: 4096 })); assert.throws(() => recovered(f, review), { code: 'COPY_SPACE' }); noRecoveryOutputs(f);
});

test('mutating backup, output or journal during copying blocks publication', t => {
  for (const kind of ['backup', 'output', 'journal']) {
    const f = fixture(t), review = inspectRegenerationRecovery(f.directory);
    assert.throws(() => recovered(f, review, p => {
      if (p.phase !== 'Validating recovered backup copy') return;
      if (kind === 'journal') editJournal(f, { status: 'validating' });
      else fs.writeFileSync(path.join(kind === 'backup' ? f.backup : path.join(p.directory, 'world'), 'opaque.dat'), 'tampered');
    })); noRecoveryOutputs(f); assert.ok(fs.existsSync(f.backup));
  }
});

test('staging replacement is not deleted and fresh final destinations are never overwritten', t => {
  const f = fixture(t), review = inspectRegenerationRecovery(f.directory); let moved, replacement;
  assert.throws(() => recovered(f, review, p => {
    if (p.phase !== 'Recovery staging created') return;
    moved = p.directory + '-moved'; replacement = p.directory; fs.renameSync(p.directory, moved); fs.mkdirSync(p.directory); fs.writeFileSync(path.join(p.directory, 'not-ours'), 'preserve');
  }), { code: 'RECOVERY_CHANGED' });
  assert.equal(fs.readFileSync(path.join(replacement, 'not-ours'), 'utf8'), 'preserve'); assert.ok(fs.existsSync(moved));
  fs.rmSync(replacement, { recursive: true }); fs.rmSync(moved, { recursive: true });
  let reserved;
  assert.throws(() => recovered(f, review, p => { if (p.phase === 'Validating recovered backup copy') { reserved = path.join(path.dirname(p.directory), path.basename(p.directory).slice(1, -8)); fs.mkdirSync(reserved); fs.writeFileSync(path.join(reserved, 'not-ours'), 'preserve'); } }), { code: 'RECOVERY_CHANGED' });
  assert.equal(fs.readFileSync(path.join(reserved, 'not-ours'), 'utf8'), 'preserve');
});

test('replacing owned world root or child directory with a symlink creates no outside files', t => {
  for (const kind of ['root', 'child']) {
    const f = fixture(t), review = inspectRegenerationRecovery(f.directory), outside = path.join(f.base, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'sentinel'), 'preserve');
    const before = content(outside); let stage, changed = false;
    assert.throws(() => recovered(f, review, p => {
      if (p.phase === 'Recovery staging created') { stage = p.directory; if (kind !== 'root') return; fs.rmdirSync(path.join(stage, 'world')); fs.symlinkSync(outside, path.join(stage, 'world')); }
      if (kind === 'child' && p.phase === 'Copying recovered backup' && !changed) { changed = true; const child = path.join(stage, 'world', 'data'); fs.rmSync(child, { recursive: true }); fs.symlinkSync(outside, child); }
    })); assert.deepEqual(content(outside), before); noRecoveryOutputs(f);
  }
});

test('process killed after backup completion leaves an inspectable .partial transaction', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t, { exportCopy: false });
  const url = relative => pathToFileURL(path.resolve(relative)).href;
  const script = `import {inspectWorld} from ${JSON.stringify(url('engine/world.js'))};import {createRegenerationReview} from ${JSON.stringify(url('engine/regeneration.js'))};import {createRegeneratedCopy} from ${JSON.stringify(url('engine/regeneration-export.js'))};const world=inspectWorld(${JSON.stringify(f.source)});const dimension=world.dimensions.find(d=>d.id==='minecraft:overworld').key;const review=createRegenerationReview(world,[{x:0,z:0,dimension}],[],{bufferChunks:0});let validations=0;createRegeneratedCopy(world,review,${JSON.stringify(f.base)},${JSON.stringify(acknowledgement)},p=>{if(p.phase==='Validating source'&&++validations===2)process.kill(process.pid,'SIGKILL');});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 15000 }); assert.equal(child.signal, 'SIGKILL', child.stderr?.toString());
  f.directory = path.join(f.base, fs.readdirSync(f.base).find(n => n.endsWith('.partial')));
  const review = inspectRegenerationRecovery(f.directory); assert.equal(review.status, 'creating-working-copy'); assert.equal(review.recoverable, true);
  assert.deepEqual(content(recovered(f, review).world), content(f.source));
});
