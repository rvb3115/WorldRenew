import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { compareVersions, parseVersion } from '../updates/version.js';
import { verifyManifest } from '../updates/manifest.js';
import { openHTTPS, readHTTPS, trustedURL } from '../updates/transport.js';
import { UpdateService, defaults } from '../updates/service.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const config = { repository: 'example/WorldRenew', publicKeys: { test: publicKey.export({ type: 'spki', format: 'pem' }) } };
const now = Date.parse('2026-10-14T12:00:00Z');
const bytes = Buffer.from('synthetic package, never executable');
function manifest(changes = {}) {
  return { schemaVersion: 1, repository: config.repository, tag: 'v0.6.0', version: '0.6.0', channel: 'stable', publishedAt: new Date(now - 60000).toISOString(), expiresAt: new Date(now + 86400000).toISOString(), notes: '<img src=x onerror=alert(1)>\nRelease notes', packages: [{ platform: 'darwin', arch: 'arm64', name: 'WorldRenew.zip', format: 'zip', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }], ...changes };
}
function envelope(m = manifest(), key = privateKey) {
  const data = Buffer.from(JSON.stringify(m));
  return { keyId: 'test', payload: data.toString('base64'), signature: sign(null, data, key).toString('base64') };
}
const context = { tag: 'v0.6.0', platform: 'darwin', arch: 'arm64', now };
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'worldrenew-updates-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const open = async url => {
    calls.push(url);
    if (url.includes('api.github.com')) return Readable.from([Buffer.from(JSON.stringify(options.releases ?? [{ tag_name: 'v0.6.0', draft: false, prerelease: false }]))]);
    if (url.endsWith('worldrenew-update.json')) return Readable.from([Buffer.from(JSON.stringify(options.envelope ?? envelope()))]);
    if (options.downloadError) throw new Error('offline');
    return Readable.from([options.bytes ?? bytes]);
  };
  const params = { directory: path.join(root, 'updates'), config, currentVersion: '0.5.2', platform: 'darwin', arch: 'arm64', now: () => now, open, ...options };
  return { root, calls, params, service: new UpdateService(params) };
}

test('SemVer compares numeric core, prerelease identifiers, build metadata and large numbers', () => {
  const ordered = ['0.5.2', '0.6.0-alpha', '0.6.0-alpha.1', '0.6.0-beta.2', '0.6.0-beta.10', '0.6.0-rc.1', '0.6.0', '0.10.0', '1.0.0', '9999999999999999999.0.0'];
  for (let i = 1; i < ordered.length; i++) { assert.equal(compareVersions(ordered[i], ordered[i - 1]), 1); assert.equal(compareVersions(ordered[i - 1], ordered[i]), -1); }
  assert.equal(compareVersions('v1.0.0+a', '1.0.0+b'), 0);
  for (const value of ['1.2', '01.0.0', '1.0.0-beta.01', '../1.0.0', '1.0.0\n', null]) assert.throws(() => parseVersion(value));
});

test('signed manifest binds repository, release, platform, size, checksum, dates and channel', () => {
  assert.equal(verifyManifest(envelope(), config, context).version, '0.6.0');
  const mutations = [{ repository: 'attacker/repo' }, { version: '0.7.0' }, { channel: 'dev' }, { expiresAt: new Date(now - 1).toISOString() }, { publishedAt: new Date(now + 900000).toISOString() }, { expiresAt: new Date(now + 40 * 86400000).toISOString() }, { notes: 3 }, { packages: [] }, { packages: [manifest().packages[0], manifest().packages[0]] }];
  for (const m of mutations) assert.throws(() => verifyManifest(envelope(manifest(m)), config, context));
  for (const change of [{ name: '../evil.zip' }, { name: 'WorldRenew.exe' }, { size: 2 ** 32 }, { size: -1 }, { sha256: '' }, { platform: 'win32' }, { arch: 'x64' }]) {
    assert.throws(() => verifyManifest(envelope(manifest({ packages: [{ ...manifest().packages[0], ...change }] })), config, context));
  }
  assert.throws(() => verifyManifest({ ...envelope(), keyId: 'unknown' }, config, context));
  assert.throws(() => verifyManifest({ ...envelope(), payload: Buffer.from('{}').toString('base64') }, config, context));
  assert.throws(() => verifyManifest(envelope(manifest(), generateKeyPairSync('ed25519').privateKey), config, context));
  assert.throws(() => verifyManifest(envelope(), config, { ...context, tag: 'v0.7.0' }));
});

test('network rejects HTTP, credentials, untrusted hosts and redirect downgrade; verifies TLS', async () => {
  for (const url of ['http://github.com/x', 'https://github.com.evil.test/x', 'https://user:pass@github.com/x', 'https://127.0.0.1/x', 'https://github.com:444/x', 'https://github.com/x#y']) assert.throws(() => trustedURL(url));
  let calls = 0;
  const get = (url, options, callback) => {
    calls++; assert.equal(options.rejectUnauthorized, true);
    const req = new EventEmitter(); req.setTimeout = () => {}; req.destroy = error => req.emit('error', error);
    queueMicrotask(() => callback(Object.assign(Readable.from([]), { statusCode: 302, headers: { location: 'http://github.com/insecure' } })));
    return req;
  };
  await assert.rejects(openHTTPS('https://github.com/good', { get }), /trusted HTTPS/); assert.equal(calls, 1);
  await assert.rejects(readHTTPS('https://github.com/x', 3, { open: async () => Readable.from([Buffer.from('1234')]) }), /size limit/);
});

test('unconfigured source and automatic-check opt-out make no requests; manual check still works', async t => {
  const f = fixture(t);
  f.service.config = { repository: null, publicKeys: {} };
  assert.equal((await f.service.check()).configured, false); assert.equal(f.calls.length, 0);
  f.service.config = config;
  f.service.saveSettings({ ...defaults, automaticChecks: false, automaticDownloads: true });
  await f.service.check({ automatic: true }); assert.equal(f.calls.length, 0);
  await f.service.check(); assert.equal(f.calls.length, 2); assert.equal(fs.existsSync(path.join(f.params.directory, 'staged.json')), false);
  assert.equal(new UpdateService(f.params).status().settings.automaticChecks, false);
  assert.throws(() => f.service.saveSettings({ ...defaults, url: 'https://evil.test' }));
});

test('stable ignores prereleases and drafts; beta uses SemVer, never downgrades', async t => {
  const releases = [ { tag_name: 'v0.7.0-beta.2', draft: false, prerelease: true }, { tag_name: 'v0.7.0-beta.10', draft: false, prerelease: true }, { tag_name: 'v9.0.0', draft: true, prerelease: false }, { tag_name: 'junk', draft: false, prerelease: false }, { tag_name: 'v0.5.1', draft: false, prerelease: false } ];
  const m = manifest({ version: '0.7.0-beta.10', tag: 'v0.7.0-beta.10', channel: 'beta' });
  const f = fixture(t, { releases, envelope: envelope(m) });
  assert.equal((await f.service.check()).release, null);
  f.service.saveSettings({ ...defaults, channel: 'beta' });
  assert.equal((await f.service.check()).release.version, '0.7.0-beta.10');
  f.service.saveSettings({ ...defaults }); assert.equal(f.service.status().release, null);
  await assert.rejects(f.service.stage(), /Check for/);
});

test('verified staging survives restart, preserves saves, detects tampering and never installs', async t => {
  const f = fixture(t), save = path.join(f.root, 'save'); fs.mkdirSync(save); fs.writeFileSync(path.join(save, 'level.dat'), 'untouched');
  const before = fs.statSync(path.join(save, 'level.dat'));
  await f.service.check(); await f.service.stage();
  const restarted = new UpdateService(f.params), file = await restarted.verifiedStagedFile();
  assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(restarted.status().installationSupported, false);
  assert.equal(fs.readFileSync(path.join(save, 'level.dat'), 'utf8'), 'untouched');
  assert.equal(fs.statSync(path.join(save, 'level.dat')).mtimeMs, before.mtimeMs);
  fs.writeFileSync(file, Buffer.alloc(bytes.length));
  await assert.rejects(restarted.verifiedStagedFile(), /modified/);
});

test('bad/truncated/oversize packages and offline failures cannot replace an earlier verified download', async t => {
  const f = fixture(t); await f.service.check(); await f.service.stage();
  const receipt = fs.readFileSync(path.join(f.params.directory, 'staged.json'));
  for (const data of [Buffer.from('bad'), Buffer.alloc(bytes.length), Buffer.alloc(bytes.length + 1)]) {
    f.service.open = async () => Readable.from([data]);
    await assert.rejects(f.service.stage(), /verification failed|signed size/);
    assert.deepEqual(fs.readFileSync(path.join(f.params.directory, 'staged.json')), receipt);
    assert.equal(fs.readdirSync(f.params.directory).some(x => x.endsWith('.partial')), false);
  }
  f.service.open = async () => { throw new Error('offline'); };
  await assert.rejects(f.service.stage(), /offline/);
  assert.deepEqual(fs.readFileSync(path.join(f.params.directory, 'staged.json')), receipt);
});

test('world activity and concurrent update requests are gated', async t => {
  const f = fixture(t, { isWorldBusy: () => true });
  await assert.rejects(f.service.check(), /current operation/); assert.equal(f.calls.length, 0);
  f.service.isWorldBusy = () => false;
  let release; f.service.open = async () => { await new Promise(resolve => { release = resolve; }); return Readable.from([Buffer.from('[]')]); };
  const pending = f.service.check();
  await assert.rejects(f.service.check(), /current operation/);
  assert.throws(() => f.service.saveSettings(defaults), /finish/);
  release(); await pending;
});

test('automatic downloading is opt-in; corrupt settings fail closed', async t => {
  const f = fixture(t); await f.service.check({ automatic: true });
  assert.equal(f.calls.length, 2); assert.equal(fs.existsSync(path.join(f.params.directory, 'staged.json')), false);
  f.service.saveSettings({ ...defaults, automaticDownloads: true }); await f.service.check({ automatic: true });
  assert.equal(fs.existsSync(path.join(f.params.directory, 'staged.json')), true);
  fs.writeFileSync(path.join(f.params.directory, 'settings.json'), '{broken');
  const restarted = new UpdateService(f.params); assert.equal(restarted.status().settings.automaticChecks, false);
});

test('storage inside a save and symlink staging are rejected without modifying saves', async t => {
  const f = fixture(t), save = path.join(f.root, 'save'); fs.mkdirSync(save); fs.writeFileSync(path.join(save, 'level.dat'), 'original');
  const unsafe = new UpdateService({ ...f.params, directory: path.join(save, 'updates') });
  assert.throws(() => unsafe.saveSettings(defaults), /Minecraft world/); assert.equal(fs.existsSync(path.join(save, 'updates')), false);
  await f.service.check(); await f.service.stage();
  const { id } = JSON.parse(fs.readFileSync(path.join(f.params.directory, 'staged.json')));
  fs.rmSync(path.join(f.params.directory, id), { recursive: true }); fs.symlinkSync(save, path.join(f.params.directory, id));
  await assert.rejects(f.service.verifiedStagedFile(), /ordinary directories|Minecraft world/);
  assert.equal(fs.readFileSync(path.join(save, 'level.dat'), 'utf8'), 'original');
});

test('expired metadata and failed signatures cannot fall back to an older release or stale candidate', async t => {
  const f = fixture(t); await f.service.check();
  f.service.now = () => now + 2 * 86400000;
  await assert.rejects(f.service.stage(), /expired/);
  await assert.rejects(f.service.check(), /expired/);
  assert.equal(f.service.status().release, null);
});

test('HTTP errors, redirect loops, and aborted requests fail without accepting a response', async () => {
  for (const status of [403, 404, 429, 500]) {
    const get = (_url, _options, callback) => {
      const request = new EventEmitter(); request.setTimeout = () => {};
      queueMicrotask(() => callback(Object.assign(Readable.from([]), { statusCode: status, headers: {} })));
      return request;
    };
    await assert.rejects(openHTTPS('https://api.github.com/repos/example/WorldRenew/releases', { get }), new RegExp(`HTTP ${status}`));
  }
  let calls = 0;
  const redirect = (_url, _options, callback) => {
    calls++; const request = new EventEmitter(); request.setTimeout = () => {};
    queueMicrotask(() => callback(Object.assign(Readable.from([]), { statusCode: 302, headers: { location: 'https://github.com/loop' } })));
    return request;
  };
  await assert.rejects(openHTTPS('https://github.com/loop', { get: redirect }), /redirect/); assert.equal(calls, 6);
  const get = (_url, options) => {
    const request = new EventEmitter(); request.setTimeout = () => {};
    queueMicrotask(() => request.emit('error', options.signal.reason)); return request;
  };
  await assert.rejects(openHTTPS('https://github.com/x', { get, signal: AbortSignal.abort(new Error('cancelled')) }), /cancelled/);
});

test('GitHub channel mismatches and corrupt response bodies never yield a candidate', async t => {
  const f = fixture(t, { envelope: envelope(manifest({ channel: 'beta', version: '0.6.0-beta.1', tag: 'v0.6.0-beta.1' })), releases: [{ tag_name: 'v0.6.0', draft: false, prerelease: false }] });
  await assert.rejects(f.service.check(), /mismatch/); assert.equal(f.service.status().release, null);
  f.service.open = async () => Readable.from([Buffer.from('{truncated')]);
  await assert.rejects(f.service.check()); assert.equal(f.service.running, false);
});

test('channel switching blocks a retained beta package until beta is selected again', async t => {
  const f = fixture(t, { envelope: envelope(manifest({ channel: 'beta', version: '0.6.0-beta.1', tag: 'v0.6.0-beta.1' })), releases: [{ tag_name: 'v0.6.0-beta.1', draft: false, prerelease: true }] });
  f.service.saveSettings({ ...defaults, channel: 'beta' }); await f.service.check(); await f.service.stage();
  f.service.saveSettings(defaults); await assert.rejects(f.service.verifiedStagedFile(), /Beta channel/);
  f.service.saveSettings({ ...defaults, channel: 'beta' }); assert.ok(await f.service.verifiedStagedFile());
});

test('release signing utility produces a client-verifiable envelope and refuses overwrite', async t => {
  const { execFileSync } = await import('node:child_process');
  const f = fixture(t), input = path.join(f.root, 'manifest.json'), key = path.join(f.root, 'private.pem'), output = path.join(f.root, 'worldrenew-update.json');
  const m = manifest({ publishedAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() });
  fs.writeFileSync(input, JSON.stringify(m)); fs.writeFileSync(key, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const script = fileURLToPath(new URL('../scripts/sign-update.mjs', import.meta.url));
  execFileSync(process.execPath, [script, input, key, 'test', output], { stdio: 'pipe' });
  const signed = JSON.parse(fs.readFileSync(output));
  assert.equal(verifyManifest(signed, config, { ...context, now: Date.now() }).version, m.version);
  assert.throws(() => execFileSync(process.execPath, [script, input, key, 'test', output], { stdio: 'pipe' }));
});
