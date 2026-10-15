import { packager } from '@electron/packager';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = { platform: process.platform, arch: process.arch };
for (const arg of process.argv.slice(2)) {
  const match = /^--(platform|arch)=([a-z0-9]+)$/.exec(arg);
  if (!match) throw new Error('Usage: npm run package -- [--platform=win32|darwin|linux] [--arch=x64|arm64]');
  options[match[1]] = match[2];
}
if (!['win32', 'darwin', 'linux'].includes(options.platform) || !['x64', 'arm64'].includes(options.arch)) throw new Error('Unsupported package platform or architecture.');
// Only application runtime inputs enter the bundle. Test worlds, credentials,
// worktree metadata, CI files, build tools and previous artifacts are excluded.
const runtime = /^\/(?:desktop|engine|ui|updates|node_modules)(?:\/|$)|^\/(?:package(?:-lock)?\.json|README\.md|UPDATES\.md)$/;
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const temporary = fs.mkdtempSync(path.join(root, 'work/packager-'));
try {
const results = await packager({
  tmpdir: temporary,
  dir: root,
  name: 'WorldRenew',
  out: path.join(root, 'dist'),
  ...options,
  overwrite: true,
  asar: true,
  appBundleId: 'app.worldrenew.desktop',
  appCategoryType: 'public.app-category.utilities',
  darwinDarkModeSupport: true,
  ignore: file => file !== '' && !runtime.test(file.replaceAll('\\', '/')),
  // No OS signing/notarization is requested for these explicitly unsigned test builds.
  // Cached or fetched runtimes must match the locked Electron dependency's checksums.
  download: { cacheRoot: process.env.WORLDRENEW_ELECTRON_CACHE || path.join(root, 'work/electron-cache'), checksums: JSON.parse(fs.readFileSync(path.join(root, 'node_modules/electron/checksums.json'), 'utf8')) }
});
for (const result of results) console.log(`Packaged app: ${result}`);
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
