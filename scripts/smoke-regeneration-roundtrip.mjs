// Real desktop export -> quit -> backup recovery -> quit -> WorldRenew reopen.
// All save paths are generated here. This is NOT a Minecraft load/save test.
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createFixture, dimensions, regionPath } from '../qa/fixtures.mjs';
import { treeHashes, record } from '../qa/oracle.mjs';
import { inspectWorld } from '../engine/world.js';
import { recordSmokeLifecycle } from './smoke-lifecycle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const work = fs.mkdtempSync(path.join(root, 'work/regeneration-roundtrip-'));
const source = createFixture(path.join(work, 'generated-source'));
fs.mkdirSync(path.join(source, 'preserved-empty-directory'));
const before = treeHashes(source), original = inspectWorld(source);
const dimensionKey = name => original.dimensions.find(d => d.id === `minecraft:${name}`).key;
const fileStats = directory => Object.keys(before).map(file => {
  const stat = fs.statSync(path.join(directory, file));
  return { file, size: stat.size, mtimeMs: stat.mtimeMs };
});
const sourceStats = fileStats(source), sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const env = { ...process.env, WORLDRENEW_USER_DATA: path.join(work, 'isolated-profile'), WORLDRENEW_BACKGROUND_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.WORLDRENEW_EXECUTABLE;
const report = {
  schemaVersion: 1, passed: false, started: new Date().toISOString(), node: process.version,
  harnessCommit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout?.trim() || null,
  harnessSha256: Object.fromEntries(['scripts/smoke-regeneration-roundtrip.mjs', 'scripts/smoke-lifecycle.mjs', 'qa/fixtures.mjs', 'qa/oracle.mjs'].map(file => [file, sha256(path.join(root, file))])),
  fixtureKind: 'generated-synthetic-java-nbt-anvil-not-playable', gameLoadTested: false,
  originalWorldsUsed: false, source, sourceFileCount: Object.keys(before).length,
  originalTerrainChunks: original.totals.chunks, sessions: [], checks: [], evidence: work
};
fs.writeFileSync(path.join(work, 'source-hashes.json'), JSON.stringify(before, null, 2) + '\n');

async function session(name, action) {
  const evidence = path.join(work, name); fs.mkdirSync(evidence);
  const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : [root], env, timeout: 30000 });
  let lifecycle, page;
  try {
    lifecycle = await recordSmokeLifecycle(app, evidence);
    page = await app.firstWindow(); lifecycle.observePage(page);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    lifecycle.record('scenario-start', { name });
    const identity = await app.evaluate(({ app }) => ({ version: app.getVersion(), electron: process.versions.electron, appPath: app.getAppPath() }));
    const payloadSha256 = identity.appPath.endsWith('.asar') ? sha256(identity.appPath) : null;
    report.sessions.push({ name, ...identity, payloadSha256, evidence });
    const pick = directory => app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, directory);
    await page.waitForSelector('#open');
    await action({ page, pick, evidence });
    assert.deepEqual(errors, [], 'No renderer errors');
    lifecycle.record('scenario-passed', { name });
  } catch (error) {
    lifecycle?.record('scenario-failed', { message: error.message, stack: error.stack });
    await page?.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    lifecycle?.record('harness-close-request');
    await app.close();
    lifecycle?.record('harness-close-complete');
  }
  const events = fs.readFileSync(path.join(evidence, 'lifecycle.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const close = events.findIndex(e => e.event === 'harness-close-request');
  assert.ok(close >= 0);
  assert.equal(events.slice(0, close).some(e => ['page-closed', 'page-crashed', 'process-exit', 'application-connection-closed', 'window-close', 'render-process-gone', 'child-process-gone', 'uncaught-exception'].includes(e.event)), false, 'No unexpected lifecycle loss before normal harness close');
  const exit = events.find(e => e.event === 'process-exit');
  assert.ok(exit, 'Owned application process exited');
  assert.equal(exit.code, 0); assert.equal(exit.signal, null);
}

async function range(page, x1, x2 = x1, mode = 'replace') {
  await page.selectOption('#selection-mode', mode);
  for (const [id, value] of Object.entries({ x1, z1: 0, x2, z2: 0 })) await page.fill(`#${id}`, String(value));
  await page.click('#select-area');
}
async function open(page, pick, folder) {
  await pick(folder); await page.click('#open');
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Inspected'), null, { timeout: 30000 });
  assert.equal(await page.locator('#dimension option').count(), 3);
}
function verifyExport(transaction) {
  const result = path.join(transaction, 'result/world'), backup = path.join(transaction, 'backup/world');
  assert.deepEqual(treeHashes(source), before); assert.deepEqual(fileStats(source), sourceStats);
  assert.deepEqual(treeHashes(backup), before);
  assert.ok(fs.statSync(path.join(backup, 'preserved-empty-directory')).isDirectory());
  const after = treeHashes(result), changed = ['region', 'entities', 'poi'].map(store => path.normalize(regionPath('overworld', store)));
  assert.deepEqual(Object.keys(after), Object.keys(before));
  const changedBytes = {};
  for (const [file, digest] of Object.entries(before)) {
    if (!changed.includes(file)) { assert.equal(after[file], digest, file); continue; }
    for (const x of [0, 1, 31]) {
      const a = record(path.join(source, file), x, 0), b = record(path.join(result, file), x, 0);
      assert.ok(a && b); assert.deepEqual(b.compressed, a.compressed); assert.equal(b.timestamp, a.timestamp);
    }
    assert.ok(record(path.join(source, file), 4, 0)); assert.equal(record(path.join(result, file), 4, 0), null);
    const a = fs.readFileSync(path.join(source, file)), b = fs.readFileSync(path.join(result, file));
    assert.equal(a.length, b.length);
    changedBytes[file] = [...a.keys()].filter(i => a[i] !== b[i]);
    assert.ok(changedBytes[file].length > 0);
    assert.ok(changedBytes[file].every(i => i >= 16 && i < 20 || i >= 4112 && i < 4116), 'Only selected Anvil location/timestamp bytes change');
  }
  const validation = JSON.parse(fs.readFileSync(path.join(transaction, 'validation.json')));
  assert.equal(validation.gameLoadTested, false);
  assert.equal(validation.removedChunks.length, 1);
  assert.equal(inspectWorld(result).totals.chunks, original.totals.chunks - 1);
  report.export = { transaction, result, backup, removedChunk: { dimension: dimensionKey('overworld'), x: 4, z: 0 }, changedBytes };
  report.checks.push('UI export removes only Overworld (4,0) terrain/entity/POI slots; selected protected (0,0) and buffered (1,0) records remain byte-identical');
  report.checks.push('All other files, three players, Nether/End records, source file times and verified backup match the independent baseline');
}

try {
  await session('01-export', async ({ page, pick, evidence }) => {
    await open(page, pick, source);
    assert.equal(Number((await page.textContent('#chunk-count')).replaceAll(',', '')), original.totals.chunks);
    await page.click('#toggle-protection');
    for (const name of dimensions) {
      await page.selectOption('#dimension', dimensionKey(name)); await range(page, 0); await page.click('#protect');
    }
    await range(page, 6); await page.click('#protect'); // End gateway destination.
    assert.equal(await page.textContent('#protected-count'), '4');
    await page.click('#save');
    await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Plan saved outside'));
    await page.selectOption('#dimension', dimensionKey('overworld'));
    await range(page, 0, 1); await range(page, 4, 4, 'add');
    assert.equal(await page.textContent('#selection-count'), '3');
    await page.selectOption('#protection-buffer', '1'); await page.click('#preview');
    await page.waitForFunction(() => document.getElementById('preview-result').textContent.includes('1 candidate chunks'));
    assert.match(await page.textContent('#preview-result'), /1 protected chunks excluded · 1 buffer chunks excluded/);
    assert.match(await page.textContent('#regeneration-counts'), /1 terrain · 1 entity · 1 POI records/);
    assert.match(await page.textContent('#regeneration-findings'), /3 player records reviewed/);
    assert.equal(await page.isDisabled('#export-regeneration'), true);
    await page.check('#regeneration-ack'); assert.equal(await page.isDisabled('#export-regeneration'), true);
    await page.check('#closed'); assert.equal(await page.isDisabled('#export-regeneration'), false);
    await page.screenshot({ path: path.join(evidence, 'protected-review.png') });
    await pick(work); await page.click('#export-regeneration');
    await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Regeneration test copy exported'), null, { timeout: 30000 });
    const exports = fs.readdirSync(work).filter(name => name.startsWith('WorldRenew-regeneration-'));
    assert.equal(exports.length, 1); verifyExport(path.join(work, exports[0]));
    assert.equal(await page.isDisabled('#export-regeneration'), true);
    await page.screenshot({ path: path.join(evidence, 'export-complete.png') });
  });

  // Deliberate changes to owned fixtures only. Recovery must not consult either path.
  const offline = source + '-offline'; fs.renameSync(source, offline);
  fs.writeFileSync(path.join(report.export.result, 'level.dat'), 'Deliberately invalid QA result; recovery must use the backup.');
  const transactionBeforeRecovery = treeHashes(report.export.transaction);
  const recoveryParent = path.join(work, 'recovered'); fs.mkdirSync(recoveryParent);
  await session('02-recovery', async ({ page, pick, evidence }) => {
    assert.equal(await page.textContent('#world-name'), 'No world open');
    assert.equal(fs.existsSync(source), false);
    await page.click('#recovery-open'); await pick(report.export.transaction); await page.click('#recovery-choose');
    await page.waitForFunction(() => !window.recoveryBusy);
    assert.equal(await page.textContent('#recovery-state'), 'Backup verified');
    assert.equal(await page.isDisabled('#recovery-restore'), true);
    await page.screenshot({ path: path.join(evidence, 'backup-verified-with-source-offline.png') });
    await page.check('#recovery-closed'); await pick(recoveryParent); await page.click('#recovery-restore');
    await page.waitForFunction(() => document.getElementById('recovery-status').textContent.startsWith('Recovered copy created'), null, { timeout: 30000 });
    const recovered = await page.textContent('#recovery-result');
    assert.equal(path.dirname(path.dirname(recovered)), recoveryParent);
    assert.deepEqual(treeHashes(recovered), before);
    assert.ok(fs.statSync(path.join(recovered, 'preserved-empty-directory')).isDirectory());
    assert.deepEqual(treeHashes(report.export.transaction), transactionBeforeRecovery);
    assert.deepEqual(treeHashes(offline), before); assert.deepEqual(fileStats(offline), sourceStats);
    report.recovery = { sourceUnavailable: true, priorResultDeliberatelyInvalid: true, recovered, allFilesMatchBaseline: true, retainedTransactionUnchanged: true };
    report.checks.push('Cold-start desktop recovery succeeds with source offline and prior result invalid, creates a new copy, and preserves the entire retained transaction');
    await page.screenshot({ path: path.join(evidence, 'recovered-copy.png') });
    await page.click('#recovery-close');
  });

  await session('03-reopen', async ({ page, pick, evidence }) => {
    await open(page, pick, report.recovery.recovered);
    assert.equal(Number((await page.textContent('#chunk-count')).replaceAll(',', '')), original.totals.chunks);
    for (const name of dimensions) {
      await page.selectOption('#dimension', dimensionKey(name));
      assert.match(await page.locator('#dimension option:checked').textContent(), new RegExp(`${name === 'the_end' ? 7 : 6} chunks`));
    }
    await page.selectOption('#dimension', dimensionKey('overworld')); await page.click('#toggle-protection');
    await range(page, 4); await page.click('#preview');
    await page.waitForFunction(() => document.getElementById('preview-result').textContent.includes('1 candidate chunks'));
    assert.match(await page.textContent('#regeneration-counts'), /1 terrain · 1 entity · 1 POI records/);
    assert.deepEqual(treeHashes(report.recovery.recovered), before);
    assert.deepEqual(treeHashes(offline), before); assert.deepEqual(fileStats(offline), sourceStats);
    assert.deepEqual(treeHashes(report.export.transaction), transactionBeforeRecovery);
    await page.screenshot({ path: path.join(evidence, 'reopened-restored-world.png') });
    report.checks.push('Third desktop session opens the recovered copy with all 19 original terrain chunks and the removed terrain/entity/POI slot restored; inspection writes no world bytes');
  });
  assert.equal(new Set(report.sessions.map(s => `${s.version}:${s.payloadSha256}`)).size, 1);
  report.checks.push('All three owned app sessions exit normally after the harness close request, with no renderer errors or premature lifecycle loss');
  report.passed = true;
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  report.finished = new Date().toISOString();
  fs.writeFileSync(path.join(work, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
