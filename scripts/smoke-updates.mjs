import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const work = fs.mkdtempSync(path.join(root, 'work/updates-smoke-'));
const env = { ...process.env, WORLDRENEW_USER_DATA: path.join(work, 'app-data') }; delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.WORLDRENEW_EXECUTABLE;
const launch = () => electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : [root], env });
let app = await launch();
try {
  let page = await app.firstWindow(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.locator('#updates-panel summary').first().click();
  await page.waitForFunction(() => document.getElementById('update-status').textContent.includes('not configured'));
  await page.uncheck('#update-auto-check'); await page.selectOption('#update-channel', 'beta'); await page.click('#update-save');
  await page.waitForFunction(() => !document.getElementById('update-save').disabled);
  await page.click('#update-check');
  await page.waitForFunction(() => document.getElementById('update-status').textContent.includes('No network request'));
  assert.equal(await page.locator('#update-download').isDisabled(), true);
  await app.close(); app = await launch(); page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#updates-panel summary').first().click();
  await page.waitForFunction(() => document.getElementById('update-channel').value === 'beta');
  assert.equal(await page.isChecked('#update-auto-check'), false);
  // Replace network only inside this test process. Production has no fixture URL/key override.
  await app.evaluate(({ app, dialog, shell }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
    const path = require('node:path'), { Readable } = require('node:stream'), { EventEmitter } = require('node:events');
    const crypto = require('node:crypto'), https = require('node:https');
    const config = require(path.join(app.getAppPath(), 'updates/release-config.json'));
    const keys = crypto.generateKeyPairSync('ed25519');
    config.repository = 'example/WorldRenew'; config.publicKeys = { fixture: keys.publicKey.export({ type: 'spki', format: 'pem' }) };
    const bytes = Buffer.from('synthetic desktop smoke package; never executable');
    const m = { schemaVersion: 1, repository: config.repository, tag: 'v0.6.0-beta.1', version: '0.6.0-beta.1', channel: 'beta', publishedAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), notes: '<img src=x onerror=alert(1)>\nSigned test release', packages: [{ platform: process.platform, arch: process.arch, name: 'WorldRenew.zip', format: 'zip', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }] };
    const data = Buffer.from(JSON.stringify(m)), envelope = { keyId: 'fixture', payload: data.toString('base64'), signature: crypto.sign(null, data, keys.privateKey).toString('base64') };
    https.get = (url, options, cb) => {
      if (options.rejectUnauthorized !== true) throw new Error('TLS validation missing');
      const req = new EventEmitter(); req.setTimeout = () => {}; req.destroy = err => req.emit('error', err);
      const body = url.hostname === 'api.github.com' ? Buffer.from(JSON.stringify([{ tag_name: m.tag, draft: false, prerelease: true }])) : url.pathname.endsWith('worldrenew-update.json') ? Buffer.from(JSON.stringify(envelope)) : bytes;
      setTimeout(() => cb(Object.assign(Readable.from([body]), { statusCode: 200, headers: {} })), 250);
      return req;
    };
    // Dialogs/reveal must never launch an installer. Observe reveal instead.
    shell.showItemInFolder = file => { global.updateRevealed = file; };
    dialog.showOpenDialog = async () => { throw new Error('World workflow unexpectedly called by updates'); };
  });
  await page.click('#update-check');
  await page.waitForTimeout(100);
  const busy = await page.evaluate(() => window.worldrenew.openWorld());
  assert.match(busy.error.message, /current operation/);
  await page.waitForFunction(() => document.getElementById('update-status').textContent.includes('0.6.0-beta.1 is available'));
  assert.match(await page.textContent('#update-notes'), /<img src=x/);
  assert.equal(await page.locator('#update-notes img').count(), 0);
  await page.click('#update-download');
  await page.waitForFunction(() => document.getElementById('update-status').textContent.includes('Installation is manual'));
  await page.click('#update-reveal');
  await page.waitForFunction(() => !document.getElementById('update-reveal').disabled);
  const revealed = await app.evaluate(() => global.updateRevealed);
  assert.match(revealed, /updates[/\\].+[/\\]WorldRenew.zip$/);
  assert.match(fs.readFileSync(revealed, 'utf8'), /synthetic desktop smoke/);
  await page.screenshot({ path: path.join(work, 'updates.png') });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, packaged: Boolean(executablePath), work, checks: ['settings persist across restart', 'opt-out', 'unconfigured source', 'verified release notes rendered as text', 'operation gate', 'signed package staging', 'verified reveal without execution'] }, null, 2));
} finally { await app.close(); }
