// Verify the actual distributed archive/wrapper, in addition to the packaged app.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import net from 'node:net';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { makeWorld } from '../tests/fixtures.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!['darwin', 'win32'].includes(process.platform)) throw new Error('Run packaged smoke tests on macOS arm64 or Windows x64.');
assert.equal(process.arch, process.platform === 'darwin' ? 'arm64' : 'x64', 'Use a native runner for the distributed target.');
const staging = path.join(root, 'work/.packaged-smoke.noindex');
fs.mkdirSync(staging, { recursive: true });
const work = fs.mkdtempSync(path.join(staging, 'run-'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const target = process.platform === 'darwin' ? 'macos-arm64' : 'windows-x64';
const artifactDir = path.join(root, 'artifacts', target);
const metadata = JSON.parse(fs.readFileSync(path.join(artifactDir, 'build-info.json'), 'utf8'));
const artifact = path.join(artifactDir, metadata.file);
const hash = createHash('sha256');
for await (const chunk of fs.createReadStream(artifact)) hash.update(chunk);
assert.equal(hash.digest('hex'), metadata.sha256);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, { cwd: root, env: { ...env, ...extraEnv }, stdio: 'inherit', timeout: 180000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Smoke command failed: ${command} ${args.join(' ')}`);
}
let executable;
try {
if (process.platform === 'darwin') {
  run('/usr/bin/ditto', ['-x', '-k', artifact, work]);
  executable = path.join(work, 'WorldRenew.app/Contents/MacOS/WorldRenew');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', path.join(work, 'WorldRenew.app')]);
  assert.ok(fs.statSync(executable).mode & 0o111, 'ZIP must retain executable permission.');
  const architecture = spawnSync('/usr/bin/lipo', ['-archs', executable], { encoding: 'utf8' });
  assert.equal(architecture.status, 0); assert.equal(architecture.stdout.trim(), 'arm64');
} else executable = path.join(root, 'dist/WorldRenew-win32-x64/WorldRenew.exe');
// Existing full workflows run on the extracted macOS bundle / Windows packaged app.
for (const script of ['scripts/smoke-desktop.mjs', 'scripts/smoke-transfer.mjs', 'scripts/smoke-archive.mjs', 'scripts/smoke-terrain.mjs', 'scripts/smoke-templates.mjs', 'scripts/smoke-template-editor.mjs']) run(process.execPath, [script], { WORLDRENEW_EXECUTABLE: executable });
run(process.execPath, ['scripts/smoke-terrain.mjs', '--legacy-1.21.11'], { WORLDRENEW_EXECUTABLE: executable });
run(process.execPath, ['scripts/smoke-topographic.mjs'], { WORLDRENEW_EXECUTABLE: executable });
run(process.execPath, ['scripts/smoke-preservation.mjs'], { WORLDRENEW_EXECUTABLE: executable });
run(process.execPath, ['scripts/smoke-updates.mjs'], { WORLDRENEW_EXECUTABLE: executable });
run(process.execPath, ['scripts/smoke-terrain-cache.mjs'], { WORLDRENEW_EXECUTABLE: executable });
run(process.execPath, ['scripts/smoke-preview-location.mjs'], { WORLDRENEW_EXECUTABLE: executable });
const checks = ['container/entity removal blocks export', 'topographic rendering, picking and bounded geometry', '1.21.11 legacy terrain fixture', 'artifact SHA-256', 'packaged desktop/preservation/export', '3D transfer and Nether roof preview', 'build archive, air-mode review and isolated-copy workflow', 'bounded detailed terrain in all vanilla dimensions', 'portable local template library'];
if (process.platform === 'win32') {
  // Exercise the final single-file portable launcher as well, without changing app code.
  const fixture = makeWorld(path.join(work, 'portable-fixture'), { demo: true, dataVersion: 5023 });
  const snapshot = () => fs.readdirSync(fixture, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => {
    const file = path.join(e.parentPath, e.name);
    return [path.relative(fixture, file), createHash('sha256').update(fs.readFileSync(file)).digest('hex')];
  });
  const before = snapshot();
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer(); server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
  });
  const child = spawn(artifact, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--world=${fixture}`], { env: { ...env, WORLDRENEW_USER_DATA: path.join(work, 'portable-profile') }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(path.join(work, 'portable.log'));
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  let browser, spawnError;
  child.on('error', error => { spawnError = error; });
  try {
    const deadline = Date.now() + 60000;
    while (!browser && Date.now() < deadline) {
      if (spawnError) throw spawnError;
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert.ok(browser, 'Portable executable must open an Electron window within 60 seconds.');
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? await context.waitForEvent('page');
    await page.waitForSelector('#open');
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    assert.match(await page.textContent('.version'), new RegExp(pkg.version.replaceAll('.', '\\.')));
    await page.click('#open');
    await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Inspected'));
    assert.deepEqual(snapshot(), before);
    await page.screenshot({ path: path.join(work, 'portable.png') });
    await page.close(); await browser.close(); browser = null;
    const deadlineExit = Date.now() + 15000;
    while (child.exitCode === null && Date.now() < deadlineExit) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(child.exitCode, 0, 'Portable launcher must exit cleanly after its app closes.');
    checks.push('final portable EXE launches, inspects unchanged synthetic world and exits');
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child.exitCode === null && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    log.end();
  }
} else checks.push('distributed ZIP extracts with valid ad-hoc seal, arm64 binary, executable modes and working bundle');
checks.push('Complete overview, persistent cache, cold/warm native opens and dimension camera/selection retention');
checks.push('Exact selected-area 3D framing, negative coordinates, dimension identity and stale-response rejection');
checks.push('GitHub update preferences, checksum staging and reveal without executing a package');
const report = { passed: true, target, version: pkg.version, artifact: metadata.file, sha256: metadata.sha256, checkedAt: new Date().toISOString(), checks, originalWorldsUsed: false, gameLoadTested: false };
fs.writeFileSync(path.join(artifactDir, 'smoke-results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));

} finally {
  // Launching a test bundle can register it even in a non-indexed folder.
  // Unregister only this run's extracted bundle; never reset the app registry.
  if (process.platform === 'darwin') {
    const app = path.join(work, 'WorldRenew.app');
    if (fs.existsSync(app)) {
      const result = spawnSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-u', app], { encoding: 'utf8' });
      if (result.status !== 0) console.warn(`Could not unregister test app ${app}: ${result.stderr || result.error || result.status}`);
    }
  }
}
