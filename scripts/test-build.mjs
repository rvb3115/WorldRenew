import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
if (!['macos-arm64', 'windows-x64'].includes(target) || process.argv.length !== 3) throw new Error('Usage: node scripts/test-build.mjs macos-arm64|windows-x64');
if (target === 'macos-arm64' && process.platform !== 'darwin') throw new Error('Create the .app ZIP on macOS to retain bundle permissions and links.');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const platform = target === 'macos-arm64' ? 'darwin' : 'win32';
const arch = target === 'macos-arm64' ? 'arm64' : 'x64';
const output = path.join(root, 'artifacts', target);
fs.mkdirSync(output, { recursive: true });
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Build command failed (${result.status}): ${command}`);
}
// A failed rebuild must never leave an earlier passing report beside new bytes.
for (const report of ['build-info.json', 'smoke-results.json', 'payload-verification.json']) fs.rmSync(path.join(output, report), { force: true });
run(process.execPath, ['scripts/package.mjs', `--platform=${platform}`, `--arch=${arch}`]);
let file;
if (platform === 'darwin') {
  file = `WorldRenew-${pkg.version}-macos-arm64.app.zip`;
  // Electron's original signature no longer matches the renamed bundle. A local
  // ad-hoc seal needs no certificate/account and is not Developer ID signing.
  const bundle = path.join(root, 'dist/WorldRenew-darwin-arm64/WorldRenew.app');
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  // ZIP the complete bundle, preserving executable modes and framework symlinks.
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', path.join(root, 'dist/WorldRenew-darwin-arm64/WorldRenew.app'), path.join(output, file)]);
} else {
  file = `WorldRenew-${pkg.version}-windows-x64-portable.exe`;
  const { build, Platform, Arch } = await import('electron-builder');
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  // A testing build must not discover credentials or publish through the updater.
  for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) delete process.env[key];
  await build({ projectDir: root, prepackaged: path.join(root, 'dist/WorldRenew-win32-x64'), targets: Platform.WINDOWS.createTarget('portable', Arch.x64), publish: 'never', config: {
    appId: 'app.worldrenew.desktop', productName: 'WorldRenew', electronVersion: pkg.devDependencies.electron,
    directories: { output }, artifactName: file, npmRebuild: false, forceCodeSigning: false,
    win: { signAndEditExecutable: false }, portable: { requestExecutionLevel: 'user' }
  } });
  run(process.execPath, ['scripts/verify-portable.mjs']);
}
const hash = createHash('sha256');
for await (const chunk of fs.createReadStream(path.join(output, file))) hash.update(chunk);
const sha256 = hash.digest('hex');
const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
const metadata = { application: 'WorldRenew', version: pkg.version, target, file, bytes: fs.statSync(path.join(output, file)).size, sha256,
  commit: git.status === 0 ? git.stdout.trim() : null, dirty: status.status === 0 ? Boolean(status.stdout.trim()) : null,
  builtAt: new Date().toISOString(), host: `${process.platform}-${process.arch}`, unsignedTestBuild: true, macosAdHocSeal: platform === 'darwin', developerIDSigned: false, notarized: false, automaticInstallation: false,
  note: 'Build output only; smoke-test results are recorded separately. Cross-building Windows on macOS does not verify Windows execution.' };
fs.writeFileSync(path.join(output, `${file}.sha256`), `${sha256}  ${file}\n`);
fs.writeFileSync(path.join(output, 'build-info.json'), JSON.stringify(metadata, null, 2) + '\n');
console.log(JSON.stringify(metadata, null, 2));
