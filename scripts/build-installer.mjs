import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installerConfig } from './installer-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--prepackaged'), 'Usage: node scripts/build-installer.mjs [--prepackaged]');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
const prepackaged = path.join(root, 'dist/WorldRenew-win32-x64');
const output = path.join(root, 'artifacts/windows-installer');
fs.mkdirSync(output, { recursive: true });
const artifactName = `WorldRenew-${pkg.version}-windows-x64-setup-local-test.exe`;
for (const file of ['build-info.json', 'installer-policy.json', 'payload-verification.json', artifactName, `${artifactName}.sha256`, `${artifactName}.blockmap`]) fs.rmSync(path.join(output, file), { force: true });
if (!args.length) {
  const result = spawnSync(process.execPath, ['scripts/package.mjs', '--platform=win32', '--arch=x64'], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Windows packaging failed');
}
// Refuse stale prepackaged application code, including a mismatched version.
const asar = await import('@electron/asar');
const archive = path.join(prepackaged, 'resources/app.asar');
assert.equal(JSON.parse(asar.extractFile(archive, 'package.json')).version, pkg.version);
for (const dir of ['desktop', 'engine', 'ui', 'updates']) {
  for (const entry of fs.readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name), relative = path.relative(root, file).split(path.sep).join('/');
    assert.deepEqual(asar.extractFile(archive, relative), fs.readFileSync(file), `Stale packaged file: ${relative}`);
  }
}
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) delete process.env[key];
process.env.ELECTRON_BUILDER_CACHE = path.join(root, 'work/builder-cache');
const { build, Platform, Arch } = await import('electron-builder');
const config = installerConfig({ version: pkg.version, electronVersion: pkg.devDependencies.electron, output });
let policy;
await build({ projectDir: root, prepackaged, targets: Platform.WINDOWS.createTarget('nsis', Arch.x64), publish: 'never', config,
  effectiveOptionComputed: async ([defines]) => {
    for (const forbidden of ['DELETE_APP_DATA_ON_UNINSTALL', 'INSTALL_MODE_PER_ALL_USERS', 'RUN_AFTER_FINISH', 'MULTIUSER_INSTALLMODE_ALLOW_ELEVATION']) assert.ok(!(forbidden in defines), `Unsafe installer define: ${forbidden}`);
    assert.ok('ONE_CLICK' in defines);
    assert.equal(defines.APP_GUID, '4a4fa002-f570-5b20-bccf-7ef9f76dbe3d', 'Installer identity must match earlier local builds.');
    policy = { appId: config.appId, guid: defines.APP_GUID, perUser: true, preservesAppData: true, startMenuShortcut: true, desktopShortcut: true, expectedInstallPath: '%LOCALAPPDATA%/Programs/WorldRenew', autoLaunch: false, autoPublish: false, nativeUpgradeTested: false };
    return false;
  },
});
assert.ok(policy, 'Installer policy was not checked');
const file = config.artifactName, bytes = fs.readFileSync(path.join(output, file));
const sha256 = createHash('sha256').update(bytes).digest('hex');
fs.writeFileSync(path.join(output, 'installer-policy.json'), JSON.stringify(policy, null, 2) + '\n');
fs.writeFileSync(path.join(output, `${file}.sha256`), `${sha256}  ${file}\n`);
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
fs.writeFileSync(path.join(output, 'build-info.json'), JSON.stringify({ file, version: pkg.version, bytes: bytes.length, sha256, commit: revision.status === 0 ? revision.stdout.trim() : null, dirty: status.status === 0 ? Boolean(status.stdout.trim()) : null, host: `${process.platform}-${process.arch}`, unsigned: true, localOnly: true, windowsExecutionTested: false, builtAt: new Date().toISOString() }, null, 2) + '\n');
const verification = spawnSync(process.execPath, ['scripts/verify-installer.mjs'], { cwd: root, stdio: 'inherit' });
if (verification.error) throw verification.error;
assert.equal(verification.status, 0, 'Installer payload verification failed');
console.log(JSON.stringify({ file, sha256, policy }, null, 2));
