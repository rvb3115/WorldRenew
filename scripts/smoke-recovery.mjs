import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeWorld } from '../tests/fixtures.js';
import { inspectWorld } from '../engine/world.js';
import { createRegenerationReview } from '../engine/regeneration.js';
import { createRegeneratedCopy } from '../engine/regeneration-export.js';
import { inventory, hashFile } from '../engine/safety.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const work = fs.mkdtempSync(path.join(root, 'work/recovery-smoke-'));
const source = makeWorld(path.join(work, 'generated-source'), { dataVersion: 5023, spawn: [1024, 64, 1024] });
fs.mkdirSync(path.join(source, 'preserved-empty-directory'));
const hashes = directory => inventory(directory).files.map(f => [f.path, hashFile(path.join(directory, f.path))]);
const before = hashes(source), world = inspectWorld(source), dimension = world.dimensions.find(d => d.id === 'minecraft:overworld').key;
const review = createRegenerationReview(world, [{ dimension, x: 0, z: 0 }], [], { bufferChunks: 0 });
const options = { confirmedClosed: true, confirmedExperimental: true };
const completed = createRegeneratedCopy(world, review, work, options);
let interrupted;
assert.throws(() => createRegeneratedCopy(world, review, work, options, p => {
  if (p.phase === 'Validating regeneration copy') { interrupted = path.dirname(path.dirname(p.file)); throw new Error('Synthetic interruption'); }
}), /Synthetic interruption/);
const interruptedBefore = hashes(interrupted);
const missing = path.join(work, 'missing-backup'); fs.mkdirSync(missing);
const journal = JSON.parse(fs.readFileSync(path.join(completed.directory, 'operation.json')));
fs.writeFileSync(path.join(missing, 'operation.json'), JSON.stringify({ ...journal, status: 'backing-up', backup: null, result: null }));
const tampered = path.join(work, 'tampered-backup'); fs.cpSync(completed.directory, tampered, { recursive: true });
fs.appendFileSync(path.join(tampered, 'backup/world/level.dat'), 'tampered');
// The recorded source path is deliberately unavailable during every recovery action.
fs.renameSync(source, source + '-offline');
const output = path.join(work, 'recovered'); fs.mkdirSync(output);
const env = { ...process.env, WORLDRENEW_USER_DATA: path.join(work, 'profile') }; delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.WORLDRENEW_EXECUTABLE;
const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : [root], env, timeout: 30000 });
const checks = [], errors = [];
try {
  const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  const pick = folder => app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, folder);
  const choose = async folder => { await pick(folder); await page.click('#recovery-choose'); await page.waitForFunction(() => !window.recoveryBusy); };
  await page.click('#recovery-open'); assert.equal(await page.textContent('#world-name'), 'No world open');
  assert.equal(await page.isDisabled('#recovery-restore'), true);
  await choose(completed.directory);
  assert.equal(await page.textContent('#recovery-state'), 'Backup verified');
  assert.match(await page.textContent('#recovery-details'), /Completed regeneration export/);
  assert.equal(await page.isDisabled('#recovery-restore'), true);
  const forged = await page.evaluate(() => window.worldrenew.restoreRecovery({ reviewDigest: 'forged', confirmedClosed: true }));
  assert.match(forged.error.message, /Verify the retained backup/);
  await page.check('#recovery-closed'); assert.equal(await page.isDisabled('#recovery-restore'), false);
  await page.screenshot({ path: path.join(work, 'verified-backup.png') });
  checks.push('Cold-start recovery without an open or available source world; explicit acknowledgment and retained digest gate');

  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  await page.click('#recovery-restore'); await page.waitForFunction(() => !window.recoveryBusy);
  assert.equal(fs.readdirSync(output).length, 0); assert.equal(await page.isDisabled('#recovery-restore'), false);
  fs.appendFileSync(path.join(completed.directory, 'backup/manifest.json'), '\n');
  await pick(output); await page.click('#recovery-restore'); await page.waitForFunction(() => !window.recoveryBusy);
  assert.equal(await page.isDisabled('#recovery-restore'), true); assert.equal(fs.readdirSync(output).length, 0);
  assert.equal(await page.locator('#recovery-status').evaluate(el => el.classList.contains('error')), true);
  checks.push('Canceled folder choice makes no copy; changed review blocks publication and clears acknowledgment');

  await choose(completed.directory); const completedBefore = hashes(completed.directory);
  await page.check('#recovery-closed'); await pick(output); await page.click('#recovery-restore');
  await page.waitForFunction(() => document.getElementById('recovery-status').textContent.startsWith('Recovered copy created'), { timeout: 30000 });
  const recovered = await page.textContent('#recovery-result'); assert.deepEqual(hashes(recovered), before);
  assert.ok(fs.statSync(path.join(recovered, 'preserved-empty-directory')).isDirectory());
  assert.deepEqual(hashes(completed.directory), completedBefore);
  assert.equal(await page.isVisible('#recovery-reveal'), true);
  await app.evaluate(({ shell }) => { shell.showItemInFolder = file => { globalThis.recoveredShown = file; }; });
  await page.click('#recovery-reveal'); await page.waitForFunction(() => !window.recoveryBusy);
  assert.equal(await app.evaluate(() => globalThis.recoveredShown), recovered);
  await page.screenshot({ path: path.join(work, 'recovered-copy.png') });
  checks.push('Recovered files and empty directories match backup; original export unchanged; reveal uses only created copy');

  // A previously opened world can disappear too; its exclusion path must not be reopened by recovery.
  await page.click('#recovery-close'); await pick(source + '-offline'); await page.click('#open');
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Inspected'));
  fs.renameSync(source + '-offline', source + '-moved-again');
  await page.click('#recovery-open'); await choose(interrupted); assert.equal(await page.textContent('#recovery-state'), 'Backup verified');
  assert.match(await page.textContent('#recovery-details'), /working copy discarded/);
  await page.check('#recovery-closed'); await pick(output); await page.click('#recovery-restore');
  await page.waitForFunction(() => document.getElementById('recovery-status').textContent.startsWith('Recovered copy created'), { timeout: 30000 });
  assert.deepEqual(hashes(await page.textContent('#recovery-result')), before); assert.deepEqual(hashes(interrupted), interruptedBefore);
  checks.push('Interrupted export recovers only the complete backup even after the open source moves; retained transaction unchanged');

  await choose(missing); assert.equal(await page.textContent('#recovery-state'), 'No completed backup available');
  assert.equal(await page.isDisabled('#recovery-restore'), true); assert.equal(await page.isDisabled('#recovery-closed'), true);
  await choose(tampered); assert.equal(await page.textContent('#recovery-state'), 'Backup could not be verified');
  assert.equal(await page.isDisabled('#recovery-restore'), true); assert.ok((await page.textContent('#recovery-blockers')).length > 0);
  await page.screenshot({ path: path.join(work, 'invalid-backup.png') });
  checks.push('Missing and altered backups are visibly distinct, blocked states');

  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = () => new Promise(resolve => { globalThis.resolveRecoveryPicker = resolve; }); });
  await page.click('#recovery-choose'); assert.equal(await page.isDisabled('#recovery-close'), true);
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#recovery-dialog').evaluate(el => el.open), true);
  await app.evaluate(() => globalThis.resolveRecoveryPicker({ canceled: true, filePaths: [] }));
  await page.waitForFunction(() => !window.recoveryBusy); await page.click('#recovery-close');
  assert.deepEqual(hashes(source + '-moved-again'), before); assert.deepEqual(errors, []);
  checks.push('Busy dialog cannot close mid-operation; canceled chooser unlocks controls; no renderer errors or source mutations');
  const report = { passed: true, fixtureOnly: true, gameLoadTested: false, checks, screenshots: work };
  fs.writeFileSync(path.join(work, 'results.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
} finally { await app.close(); }
