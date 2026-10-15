import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { compareVersions, parseVersion } from './version.js';
import { assetURL, validateConfig, verifyManifest } from './manifest.js';
import { openHTTPS, readHTTPS } from './transport.js';
import {githubConfigured,githubReleaseURL,verifyGitHubRelease} from './github-release.js';

export const defaults = Object.freeze({ automaticChecks: true, automaticDownloads: false, channel: 'stable' });
function settings(value) {
  if (!value || typeof value.automaticChecks !== 'boolean' || typeof value.automaticDownloads !== 'boolean' || !['stable', 'beta'].includes(value.channel) || Object.keys(value).some(k => !Object.hasOwn(defaults, k))) throw new Error('Invalid update settings.');
  return { ...value };
}
function safeDirectory(directory) {
  directory = path.resolve(directory);
  for (let p = directory; ; p = path.dirname(p)) {
    if (fs.existsSync(path.join(p, 'level.dat'))) throw new Error('Update storage cannot be inside a Minecraft world.');
    if (fs.existsSync(p) && (fs.lstatSync(p).isSymbolicLink() || !fs.lstatSync(p).isDirectory())) throw new Error('Update storage must use ordinary directories.');
    if (p === path.dirname(p)) break;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}
function readJSON(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Invalid update state file.');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function atomicJSON(root, name, value) {
  safeDirectory(root);
  const temp = path.join(root, `${randomUUID()}.tmp`);
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, path.join(root, name));
  } finally { fs.rmSync(temp, { force: true }); }
}

export class UpdateService {
  constructor({ directory, config, currentVersion, platform = process.platform, arch = process.arch, isWorldBusy = () => false, open = openHTTPS, now = Date.now }) {
    this.directory = path.resolve(directory); this.config = config; this.currentVersion = currentVersion;
    parseVersion(currentVersion);
    this.platform = platform; this.arch = arch; this.isWorldBusy = isWorldBusy; this.open = open; this.now = now;
    this.preferences = { ...defaults }; this.candidate = null; this.running = false; this.message = ''; this.lastChecked = null;
    try {
      safeDirectory(this.directory);
      const file = path.join(this.directory, 'settings.json');
      if (fs.existsSync(file)) this.preferences = settings(readJSON(file));
    } catch (error) {
      // Corrupt preferences must never silently opt someone back into network access.
      this.preferences = { ...defaults, automaticChecks: false }; this.message = error.message;
    }
  }
  status() {
    let configured = false;
    try { configured = githubConfigured(this.config)||validateConfig(this.config); } catch (error) { this.message = error.message; }
    return { currentVersion: this.currentVersion, settings: { ...this.preferences }, configured,
      running: this.running, lastChecked: this.lastChecked, message: this.message,
      installationSupported: false,source:githubConfigured(this.config)?`GitHub · ${this.config.repository}`:'Signed release manifest',
      release: this.candidate ? { version: this.candidate.manifest.version, notes: this.candidate.manifest.notes, channel: this.candidate.manifest.channel,verification:this.candidate.manifest.verification??'signed-manifest' } : null };
  }
  saveSettings(value) {
    if (this.running) throw new Error('Wait for the update request to finish.');
    const next = settings(value);
    atomicJSON(this.directory, 'settings.json', next);
    if (next.channel !== this.preferences.channel) this.candidate = null;
    this.preferences = next;
    return this.status();
  }
  async exclusive(action) {
    if (this.running || this.isWorldBusy()) throw new Error('Wait for the current operation to finish.');
    this.running = true;
    try { return await action(); }
    catch (error) { this.message = error.message; throw error; }
    finally { this.running = false; }
  }
  async check({ automatic = false } = {}) {
    if (automatic && !this.preferences.automaticChecks) return this.status();
    await this.exclusive(async () => {
      this.candidate = null;
      const github=githubConfigured(this.config);
      if (!github&&!validateConfig(this.config)) { this.message = 'Release source and signing key are not configured. No network request was made.'; return; }
      const signal = AbortSignal.timeout(60000);
      const releases = [];
      // Bounded pagination: do not silently report "up to date" if the bound is exceeded.
      for (let page = 1; page <= 5; page++) {
        const batch = JSON.parse(await readHTTPS(`https://api.github.com/repos/${this.config.repository}/releases?per_page=100&page=${page}`, 4 * 1024 ** 2, { signal, open: this.open }));
        if (!Array.isArray(batch)) throw new Error('Invalid release list.');
        releases.push(...batch);
        if (batch.length < 100) break;
        if (page === 5) throw new Error('Too many releases to check safely.');
      }
      const eligible = releases.filter(r => {
        try {
          const v = parseVersion(r.tag_name);
          return !r.draft && typeof r.prerelease === 'boolean' && (this.preferences.channel === 'beta' || !r.prerelease) &&
            (r.prerelease ? github?Boolean(v.pre.length):v.pre[0] === 'beta' : !v.pre.length) && compareVersions(r.tag_name, this.currentVersion) > 0;
        } catch { return false; }
      }).sort((a, b) => compareVersions(b.tag_name, a.tag_name));
      if (eligible.length) {
        const r = eligible[0];
        const envelope = github?{source:'github-releases',releaseId:r.id}:JSON.parse(await readHTTPS(assetURL(this.config.repository, r.tag_name, 'worldrenew-update.json'), 750000, { signal, open: this.open }));
        const manifest = github?await this.githubManifest(envelope,r.tag_name):verifyManifest(envelope, this.config, { tag: r.tag_name, platform: this.platform, arch: this.arch, now: this.now() });
        if ((manifest.channel === 'beta') !== r.prerelease) throw new Error('Release channel does not match signed metadata.');
        this.candidate = { envelope, manifest };
        this.message = `WorldRenew ${manifest.version} is available. ${github?'Download is checked against GitHub’s SHA-256; the package is not publisher-signed. ':''}Downloading does not install it.`;
      } else this.message = `No newer release is available for this channel. Running ${this.currentVersion}; older public releases will not replace it.`;
      this.lastChecked = new Date(this.now()).toISOString();
    });
    if (automatic && this.preferences.automaticDownloads && this.candidate && !this.isWorldBusy()) await this.stage();
    return this.status();
  }
  async githubManifest(envelope,tag){
    if(envelope.source!=='github-releases'||!githubConfigured(this.config))throw new Error('Update source changed. Check again.');
    const release=JSON.parse(await readHTTPS(githubReleaseURL(this.config.repository,envelope.releaseId),750000,{signal:AbortSignal.timeout(60000),open:this.open}));
    const manifest=verifyGitHubRelease(release,this.config,{platform:this.platform,arch:this.arch});
    if(manifest.tag!==tag||manifest.releaseId!==envelope.releaseId)throw new Error('GitHub release identity changed. Check again.');return manifest;
  }
  async stage() {
    await this.exclusive(async () => {
      if (!this.candidate) throw new Error('Check for a verified release first.');
      const { envelope, manifest: previous } = this.candidate;
      const manifest = envelope.source==='github-releases'?await this.githubManifest(envelope,previous.tag):verifyManifest(envelope, this.config, { tag: previous.tag, platform: this.platform, arch: this.arch, now: this.now() });
      if(manifest.package.sha256!==previous.package.sha256||manifest.package.size!==previous.package.size||manifest.package.name!==previous.package.name||manifest.package.id!==previous.package.id)throw new Error('Release asset changed since checking. Check again.');
      if (compareVersions(manifest.version, this.currentVersion) <= 0 || (this.preferences.channel === 'stable' && manifest.channel !== 'stable')) throw new Error('Update is no longer eligible.');
      const root = safeDirectory(this.directory), id = randomUUID(), temp = path.join(root, `${id}.partial`), final = path.join(root, id);
      fs.mkdirSync(temp, { mode: 0o700 });
      try {
        const file = await fsp.open(path.join(temp, manifest.package.name), 'wx', 0o600);
        const hash = createHash('sha256'); let size = 0;
        try {
          const stream = await this.open(manifest.package.url, { signal: AbortSignal.timeout(15 * 60000) });
          try {
            for await (const chunk of stream) {
              size += chunk.length;
              if (size > manifest.package.size) throw new Error('Package exceeds signed size or GitHub size.');
              hash.update(chunk); await file.writeFile(chunk);
            }
          } finally { stream.destroy(); }
          if (size !== manifest.package.size || hash.digest('hex') !== manifest.package.sha256) throw new Error('Package checksum or size verification failed.');
          await file.sync();
        } finally { await file.close(); }
        atomicJSON(temp, 'release.json', envelope.source==='github-releases'?{...envelope,package:manifest.package}:envelope);
        fs.renameSync(temp, final);
        atomicJSON(root, 'staged.json', { id, tag: manifest.tag });
        this.message = `Verified ${manifest.version} staged. Installation is manual; quit WorldRenew after all world operations finish. Keep your previous app for rollback.`;
      } finally { fs.rmSync(temp, { recursive: true, force: true }); }
    });
    return this.status();
  }
  async verifiedStagedFile() {
    // Reverify after restart and before revealing a package; the receipt alone is never authority.
    return this.exclusive(async () => {
      safeDirectory(this.directory);
      if (!fs.existsSync(path.join(this.directory, 'staged.json'))) throw new Error('No verified download is staged. Check for updates and download one first.');
      const record = readJSON(path.join(this.directory, 'staged.json'));
      if (!/^[a-f0-9-]{36}$/.test(record.id)) throw new Error('Invalid staged receipt.');
      const directory = safeDirectory(path.join(this.directory, record.id));
      const envelope = readJSON(path.join(directory, 'release.json'));
      const manifest = envelope.source==='github-releases'?await this.githubManifest(envelope,record.tag):verifyManifest(envelope, this.config, { tag: record.tag, platform: this.platform, arch: this.arch, now: this.now() });
      if(compareVersions(manifest.version,this.currentVersion)<=0)throw new Error('Staged download is not newer than this app; refusing a downgrade or reinstall.');
      if(envelope.source==='github-releases'&&(manifest.package.id!==envelope.package?.id||manifest.package.sha256!==envelope.package?.sha256))throw new Error('Published asset changed after download. Check again.');
      if (this.preferences.channel === 'stable' && manifest.channel !== 'stable') throw new Error('Staged package belongs to the Beta channel.');
      const file = path.join(directory, manifest.package.name), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== manifest.package.size) throw new Error('Staged package was modified.');
      const hash = createHash('sha256');
      for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
      if (hash.digest('hex') !== manifest.package.sha256) throw new Error('Staged package was modified.');
      return file;
    });
  }
}
