import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { inspectWorld } from '../engine/world.js';
import { createVerifiedCopy } from '../engine/safety.js';

// Opt-in integration test: accepts an explicit world, never starts Minecraft,
// and performs UI actions only on an independently verified test copy.
const source = process.argv[2];
if (!source || !process.argv.includes('--closed')) {
  console.error('Usage: npm run test:real -- "/path/to/world" --closed\nClose Minecraft and every server using that world before passing --closed.');
  process.exit(1);
}
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.mkdirSync(path.join(project, 'work'), { recursive: true });
const run = fs.mkdtempSync(path.join(project, 'work/real-world-'));
function hashes(folder) {
  const entries = [];
  function walk(relative) {
    for (const item of fs.readdirSync(path.join(folder, relative), { withFileTypes: true })) {
      const rel = path.join(relative, item.name), file = path.join(folder, rel);
      if (item.isDirectory()) walk(rel);
      else {
        assert.ok(item.isFile(), `Unexpected non-regular file: ${rel}`);
        const before = fs.statSync(file), fd = fs.openSync(file, 'r'), hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
        try { let n; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, n)); }
        finally { fs.closeSync(fd); }
        const after = fs.statSync(file);
        assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
        entries.push({ path: rel, bytes: after.size, sha256: hash.digest('hex') });
      }
    }
  }
  walk(''); return entries.sort((a, b) => a.path.localeCompare(b.path));
}
const before = hashes(source), started = performance.now(), report = inspectWorld(source);
const inspectionMs = Math.round(performance.now() - started);
const copy = createVerifiedCopy(source, run, { confirmedClosed: true });
assert.deepEqual(hashes(copy.world), before, 'Verified copy differs from source.');
const manifest = JSON.parse(fs.readFileSync(copy.manifest, 'utf8'));
assert.deepEqual(manifest.files.slice().sort((a, b) => a.path.localeCompare(b.path)), before);
const env = { ...process.env, WORLDRENEW_USER_DATA: path.join(run, 'app-data') }; delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.WORLDRENEW_EXECUTABLE;
const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [project]), `--world=${copy.world}`], env, timeout: 30000 });
const errors = [];
try {
  const page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  await page.click('#open');
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Inspected'));
  assert.equal(await page.textContent('#world-name'), report.metadata.name);
  assert.equal(Number((await page.textContent('#chunk-count')).replaceAll(',', '')), report.totals.chunks);
  assert.equal(await page.locator('#dimension option').count(), report.dimensions.length);
  const details = await page.textContent('#metadata');
  assert.ok(details.includes(report.metadata.version));
  if (report.metadata.seed) assert.ok(details.includes(report.metadata.seed));
  assert.ok(details.includes(String(report.metadata.dataVersion)));
  await page.click('#toggle-protection');
  await page.locator('.sidebar .plain-details').evaluate(el=>el.open=true);
  const dimension = report.dimensions.find(d => d.regions.some(r => r.chunks.some(c => c.valid)));
  assert.ok(dimension, 'Test needs at least one valid existing terrain chunk.');
  const chunk = dimension.regions.flatMap(r => r.chunks).find(c => c.valid);
  await page.selectOption('#dimension', dimension.key);
  for (const [id, value] of [['x1', chunk.x], ['x2', chunk.x], ['z1', chunk.z], ['z2', chunk.z]]) await page.fill(`#${id}`, String(value));
  await page.click('#select-area'); assert.equal(await page.textContent('#selection-count'), '1');
  await page.click('#protect'); assert.equal(await page.textContent('#protected-count'), '1');
  await page.click('#save'); await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Plan saved'));
  await page.click('#preview'); await page.waitForFunction(() => document.getElementById('preview-result').textContent.startsWith('0 candidate chunks'));
  assert.ok((await page.textContent('#preview-result')).includes('1 protected chunks excluded'));
  await page.click('#clear-selection');
  await page.click('#zoom-in'); await page.click('#zoom-out'); await page.click('#fit');
  await page.screenshot({ path: path.join(run, 'real-world.png') });
  for (const d of report.dimensions) { await page.selectOption('#dimension', d.key); assert.equal(await page.textContent('#selection-count'), '0'); }
  await page.click('#rescan'); await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Inspected'));
  assert.equal(await page.textContent('#protected-count'), '1');
  // Check the native desktop copy workflow against the already verified test copy.
  const destination = path.join(run, 'desktop-copy'); fs.mkdirSync(destination);
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, destination);
  await page.check('#closed'); await page.click('#copy');
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Verified'), null, { timeout: 60000 });
  const copied = fs.readdirSync(destination).find(f => f.startsWith('WorldRenew-')); assert.ok(copied);
  assert.deepEqual(hashes(path.join(destination, copied, 'world')), before);
  assert.deepEqual(hashes(copy.world), before, 'Desktop changed its source copy.');
  assert.deepEqual(hashes(source), before, 'Original changed during the test.');
  assert.deepEqual(errors, []);
  const result = { world: report.metadata.name, version: report.metadata.version, dataVersion: report.metadata.dataVersion, chunks: report.totals.chunks, regionFiles: report.totals.regions, emptyRegionFiles: report.totals.emptyRegionFiles, dimensions: report.totals.dimensions, filesVerified: before.length, bytesVerified: before.reduce((n, f) => n + f.bytes, 0), inspectionMs, originalUnchanged: true, testCopyUnchanged: true, desktopCopyMatches: true, protectionPersistence: true, protectedPreviewExcluded: true, javascriptErrors: errors, packagedExecutable: Boolean(executablePath), run, screenshot: path.join(run, 'real-world.png') };
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await app.close(); }
