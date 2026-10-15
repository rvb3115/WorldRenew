import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { makeWorld, writeDat } from '../tests/fixtures.js';
import { playerTags, playerPath } from '../tests/preservation-fixtures.js';
import { inspectWorld } from '../engine/world.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const work = fs.mkdtempSync(path.join(root, 'work/desktop-smoke-'));
const fixture = makeWorld(path.join(work, 'synthetic-world'), { demo: true, dataVersion: 5023 });
writeDat(path.join(fixture, playerPath()), playerTags());
const treeHashes = () => fs.readdirSync(fixture, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => {
  const file = path.join(e.parentPath, e.name), stat = fs.statSync(file);
  return { path: path.relative(fixture, file), bytes: stat.size, mtimeMs: stat.mtimeMs, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
});
const before = treeHashes();
const env = { ...process.env, WORLDRENEW_USER_DATA: path.join(work, 'app-data') }; delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.WORLDRENEW_EXECUTABLE;
const app = await electron.launch({
  ...(executablePath ? { executablePath } : {}),
  args: [...(executablePath ? [] : [root]), `--world=${fixture}`], env, timeout: 30000
});
const errors = [];
try {
  const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('#open');
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  const preferences = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false);
  await page.screenshot({ path: path.join(work, 'empty-state.png') });
  await page.click('#open');
  await page.waitForFunction(() => document.getElementById('world-name').textContent.includes('Cedar Valley'));
  assert.equal(await page.locator('#dimension option').count(), 3);
  assert.ok(Number((await page.textContent('#chunk-count')).replaceAll(',', '')) > 1000);
  await page.click('#toggle-protection');
  await page.fill('#x1', '-9'); await page.fill('#z1', '-8'); await page.fill('#x2', '9'); await page.fill('#z2', '8');
  await page.click('#select-area'); assert.equal(await page.textContent('#selection-count'), '323');
  await page.click('#protect'); assert.equal(await page.textContent('#protected-count'), '323');
  await page.click('#save'); await page.waitForFunction(() => document.getElementById('status').textContent.includes('Plan saved outside'));
  await page.click('#preview'); await page.waitForFunction(() => document.getElementById('preview-result').textContent.includes('323 protected chunks excluded'));
  // Review spans the protected core, diagonal buffer and remaining candidates.
  await page.fill('#x1', '-11'); await page.fill('#z1', '-10'); await page.fill('#x2', '11'); await page.fill('#z2', '10');
  await page.click('#select-area'); assert.equal(await page.locator('#save-regeneration').isDisabled(), true);
  await page.click('#preview');
  await page.waitForFunction(() => document.getElementById('preview-result').textContent.includes('84 candidate chunks'));
  assert.ok((await page.textContent('#preview-result')).includes('76 buffer chunks excluded'));
  assert.ok((await page.textContent('#regeneration-counts')).includes('84 terrain'));
  assert.equal(await page.locator('#regeneration-legend').isVisible(), true);
  await page.click('#save-regeneration');
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Dry-run report saved outside'));
  const reports = path.join(work, 'app-data/projects/regeneration-previews');
  const report = JSON.parse(fs.readFileSync(path.join(reports, fs.readdirSync(reports)[0])));
  assert.equal(report.executable, false); assert.equal(report.backup.verified, false);
  assert.equal(report.counts.candidates, 84); assert.equal(report.counts.buffer, 76);
  assert.equal(report.playerSafety.players.length, 1); assert.equal(report.playerSafety.conflicts.length, 0);
  assert.ok((await page.textContent('#regeneration-findings')).includes('1 player records reviewed'));
  assert.ok(report.inputFiles.some(f => f.present && f.sha256));
  await page.screenshot({ path: path.join(work, 'regeneration-review.png') });
  assert.equal(await page.locator('#export-regeneration').isDisabled(), true);
  await page.check('#regeneration-ack');
  assert.equal(await page.locator('#export-regeneration').isDisabled(), true);
  await page.check('#closed');
  assert.equal(await page.locator('#export-regeneration').isEnabled(), true);
  await app.evaluate(({ dialog }, destination) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] }); }, work);
  await page.click('#export-regeneration');
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Regeneration test copy exported'), { timeout: 30000 });
  const exported = path.join(work, fs.readdirSync(work).find(n => n.startsWith('WorldRenew-regeneration-')));
  const validation = JSON.parse(fs.readFileSync(path.join(exported, 'validation.json')));
  assert.equal(validation.removedChunks.length, 84); assert.equal(validation.gameLoadTested, false);
  assert.equal(inspectWorld(path.join(exported, 'result/world')).totals.chunks, inspectWorld(fixture).totals.chunks - 84);
  assert.ok(fs.existsSync(path.join(exported, 'backup/manifest.json')));
  assert.deepEqual(treeHashes(), before);
  assert.equal(await page.locator('#export-regeneration').isDisabled(), true);
  assert.equal(await page.locator('#reveal-regeneration').isVisible(), true);
  await page.screenshot({ path: path.join(work, 'regeneration-export.png') });
  await page.click('#preview');
  await page.waitForFunction(() => document.getElementById('preview-result').textContent.includes('84 candidate chunks'));
  // A sidecar appearing after review must prevent saving even without a region timestamp change.
  const changedSidecar = path.join(fixture, 'dimensions/minecraft/overworld/poi/c.-11.-10.mcc');
  fs.writeFileSync(changedSidecar, 'unexpected external payload');
  try {
    await page.click('#save-regeneration');
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('Review inputs changed'));
    assert.equal(await page.locator('#save-regeneration').isDisabled(), true);
    assert.equal(fs.readdirSync(reports).length, 1);
    assert.equal(await page.locator('#regeneration-legend').isVisible(), false);
  } finally { fs.unlinkSync(changedSidecar); }
  await page.selectOption('#protection-buffer', '0');
  assert.equal(await page.locator('#save-regeneration').isDisabled(), true);
  assert.equal(await page.locator('#regeneration-details').isVisible(), false);
  await page.selectOption('#protection-buffer', '1');
  await page.click('#clear-selection');
  await page.screenshot({ path: path.join(work, 'inspector.png') });
  await page.selectOption('#dimension', { label: 'The Nether · 1 chunks' }); assert.equal(await page.textContent('#selection-count'), '0');
  await page.click('#rescan'); await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Inspected'));
  assert.equal(await page.textContent('#protected-count'), '323');
  // Exercise the real copy IPC while replacing only the native destination dialog.
  await app.evaluate(({ dialog }, destination) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] }); }, work);
  await page.check('#closed'); await page.click('#copy');
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Verified'), { timeout: 30000 });
  const copy = fs.readdirSync(work).find(name => name.startsWith('WorldRenew-') && !name.startsWith('WorldRenew-regeneration-')); assert.ok(copy); assert.ok(fs.existsSync(path.join(work, copy, 'manifest.json')));
  assert.deepEqual(treeHashes(), before);
  // Invalid-folder errors must be visible while keeping the previous world intact.
  await page.click('#open'); await page.waitForFunction(() => document.querySelector('.statusbar').classList.contains('error'));
  assert.ok((await page.textContent('#status')).includes('level.dat')); assert.ok((await page.textContent('#world-name')).includes('Cedar Valley'));
  assert.deepEqual(errors, []);
  console.log(`PASS: desktop launch, sandbox, metadata, dimension map, selection, protection, persistence, coordinated dry-run, protection buffer, report save/invalidation, regeneration export/acknowledgements, unchanged source, copy and error handling.\nScreenshots: ${work}`);
} finally { await app.close(); }
