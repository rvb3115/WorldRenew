// Opt-in read-only UI validation against a byte-verified, disposable snapshot.
// This test never calls the application's copy/export transactions or claims
// Minecraft was closed. A changing source aborts snapshot validation.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { inventory, hashFile } from '../engine/safety.js';
import { canonicalWorld, safePath, isWithin } from '../engine/paths.js';
import { inspectWorld } from '../engine/world.js';
import { createTerrainReader } from '../engine/terrain.js';

assert.ok(process.argv.length === 3 || process.argv.length === 4 && process.argv[3] === '--topographic', 'Usage: node scripts/smoke-terrain-copy.mjs /path/to/source-world [--topographic]');
const topographic = process.argv.includes('--topographic');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = canonicalWorld(process.argv[2]);
assert.ok(!isWithin(source, root), 'Test output must be outside the source world.');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const work = fs.mkdtempSync(path.join(root, 'work/terrain-copy-smoke-'));
const copy = path.join(work, 'world-copy'), profile = path.join(work, 'isolated-profile');
const before = inventory(source);
const bytes = before.files.reduce((sum, file) => sum + file.bytes, 0);
assert.ok(bytes <= 512 * 1024 * 1024, 'Choose a representative save below 512 MiB for this bounded smoke test.');
const hashes = before.files.map(file => ({ path: file.path, sha256: hashFile(safePath(source, file.path)) }));
fs.mkdirSync(copy);
for (const directory of before.directories) fs.mkdirSync(path.join(copy, directory), { recursive: true });
for (const file of before.files) fs.copyFileSync(safePath(source, file.path), path.join(copy, file.path), fs.constants.COPYFILE_EXCL);
function verifySourceAndCopy() {
  assert.deepEqual(inventory(source), before, 'Source inventory must stay unchanged.');
  for (const file of hashes) {
    assert.equal(hashFile(safePath(source, file.path)), file.sha256, `Source changed: ${file.path}`);
    assert.equal(hashFile(safePath(copy, file.path)), file.sha256, `Copy changed: ${file.path}`);
  }
  assert.deepEqual(inventory(source), before, 'Source changed during hashing.');
  assert.deepEqual(inventory(copy).files.map(f => f.path), before.files.map(f => f.path));
}
verifySourceAndCopy();
const world = inspectWorld(copy), dimension = world.dimensions.find(d => d.id === 'minecraft:overworld');
assert.ok(dimension, 'Choose a save with an Overworld.');
const reader = createTerrainReader(world), spawn = world.metadata.spawn;
const candidates = dimension.regions.flatMap(region => region.chunks).filter(c => c.valid !== false);
candidates.sort((a,b) => Math.hypot(a.x - (spawn?.x ?? 0) / 16, a.z - (spawn?.z ?? 0) / 16) - Math.hypot(b.x - (spawn?.x ?? 0) / 16, b.z - (spawn?.z ?? 0) / 16));
let anchor;
for (let offset = 0; offset < Math.min(128, candidates.length) && !anchor; offset += 16) {
  anchor = reader.batch({ dimension: dimension.key, chunks: candidates.slice(offset, offset + 16).map(({x,z}) => ({x,z})) }).tiles.find(tile => tile.status === 'ready' && tile.ids.some(id => id));
}
assert.ok(anchor, 'No fully supported surface found in the bounded sample; inspect the explicit terrain failures.');
const env = { ...process.env, WORLDRENEW_USER_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.WORLDRENEW_EXECUTABLE;
const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [root]), `--world=${copy}`], env, timeout: 30000 });
const errors = [];
try {
  const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.click('#open');
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Inspected'), null, { timeout: 60000 });
  await page.click('#toggle-protection');
  for (const [id, value] of Object.entries({ x1: anchor.x - 1, z1: anchor.z - 1, x2: anchor.x + 1, z2: anchor.z + 1 })) await page.fill('#' + id, String(value));
  await page.click('#select-area'); assert.equal(await page.textContent('#selection-count'), '9');
  await page.click('#fit-selection');
  await page.waitForFunction(() => Number(document.getElementById('terrain-status').dataset.ready) > 0 && document.getElementById('terrain-status').dataset.pending === '0', null, { timeout: 60000 });
  await page.click('#protect'); await page.click('#save');
  await page.waitForFunction(() => document.getElementById('save-state').textContent === 'Plan up to date');
  assert.equal(await page.textContent('#protected-count'), '9');
  await page.click('#toggle-protection');
  // Closing the panel resizes the map and reveals additional columns.
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.waitForFunction(() => Number(document.getElementById('terrain-status').dataset.ready) > 0 && document.getElementById('terrain-status').dataset.pending === '0', null, { timeout: 60000 });
  const map = await page.locator('#map').boundingBox();
  await page.mouse.move(map.x + map.width / 2, map.y + map.height / 2);
  const hover = await page.textContent('#terrain-hover');
  assert.match(hover, /minecraft:/, 'The selected center must show a decoded block.');
  await page.screenshot({ path: path.join(work, 'real-world-terrain.png') });
  let topographicMetrics = null;
  if (topographic) {
    await page.selectOption('#map-view','topographic');
    await page.waitForFunction(()=>document.getElementById('topographic-map').dataset.building==='0' && document.getElementById('terrain-status').dataset.pending==='0',null,{timeout:60000});
    topographicMetrics = await page.locator('#topographic-map').evaluate(el=>({...el.dataset}));
    assert.ok(Number(topographicMetrics.meshes)<=121);assert.ok(Number(topographicMetrics.triangles)>0);
    await page.screenshot({path:path.join(work,'real-world-topographic.png')});
  }
  const terrain = await page.locator('#terrain-status').evaluate(element => ({ ...element.dataset, text: element.textContent }));
  assert.deepEqual(errors, []);
  verifySourceAndCopy();
  const report = { passed: true, topographicMetrics, source, disposableCopy: copy, profile, executable: executablePath ?? 'development Electron', minecraftVersion: world.metadata.version, dataVersion: world.metadata.dataVersion, totalChunks: world.totals.chunks, sampledAnchor: { x: anchor.x, z: anchor.z }, terrain, hover, filesVerified: hashes.length, bytesVerified: bytes, sourceAndCopyUnchanged: true, installedProfileUsed: false, fixtureOnly: false, gameLoadTested: false, screenshots: work };
  fs.writeFileSync(path.join(work, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await app.close(); }
