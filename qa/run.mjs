import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const qa = path.dirname(fileURLToPath(import.meta.url)), root = path.dirname(qa);
if (process.argv.slice(2).some(a => a !== '--full')) throw new Error('Usage: node qa/run.mjs [--full]');
const full = process.argv.includes('--full');
const files = fs.readdirSync(qa).filter(n => n.endsWith('.test.mjs')).sort().map(n => `qa/${n}`);
if (full) files.unshift(...fs.readdirSync(path.join(root, 'tests')).filter(n => n.endsWith('.test.js')).sort().map(n => `tests/${n}`));
const runs = path.join(qa, 'runs'); fs.mkdirSync(runs, { recursive: true });
const run = fs.mkdtempSync(path.join(runs, 'run-'));
const started = new Date().toISOString();
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const output = (result.stdout ?? '') + (result.stderr ?? '');
fs.writeFileSync(path.join(run, 'tests.tap'), output);
const git = args => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout?.trim() || null;
const count = name => Number(new RegExp(`^# ${name} (\\d+)$`, 'm').exec(output)?.[1] ?? -1);
const codeFiles = [];
function collect(relative) {
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const file = `${relative}/${entry.name}`;
    if (file === 'qa/runs' || file === 'qa/evidence') continue;
    if (entry.isDirectory()) collect(file);
    else if (entry.isFile() && /\.(?:js|cjs|mjs|json|mcfunction|mcmeta)$/.test(entry.name)) codeFiles.push(file);
  }
}
for (const dir of ['engine', 'tests', 'qa', 'desktop', 'ui', 'updates']) collect(dir);
codeFiles.push('package.json', 'package-lock.json'); codeFiles.sort();
const sourceSha256 = Object.fromEntries(codeFiles.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const report = {
  schemaVersion: 1, workflow: full ? 'engine-regression-and-session3-qa' : 'session3-qa',
  started, finished: new Date().toISOString(), node: process.version,
  gitCommit: git(['rev-parse', 'HEAD']), mergeHead: git(['rev-parse', '--verify', 'MERGE_HEAD']), gitBranch: git(['branch', '--show-current']), workingTreeStatus: git(['status', '--short']),
  command: `node qa/run.mjs${full ? ' --full' : ''}`, testFiles: files,
  passed: result.status === 0 && count('fail') === 0 && count('tests') > 0,
  exitCode: result.status, error: result.error?.message ?? null,
  counts: { tests: count('tests'), pass: count('pass'), fail: count('fail'), skipped: count('skipped'), todo: count('todo') },
  fixtureKind: 'generated-synthetic-java-nbt-anvil-not-gameplay-certified',
  gameLoadTested: false, portalConnectivityValidated: false, farmFunctionalityValidated: false,
  regionImportImplemented: false, terrainBlendingImplemented: false, sourceSha256,
  compatibility: '26.3/5023 fixture envelope export; modern and legacy palette read syntax. No version upgrade or universal world certification.',
  pending: ['Game-generated vanilla fixture execution and reopen', 'Multiplayer login and portal traversal', 'Farm output measurements', 'Biome/structure/light/fluid continuity', 'Full-world entity UUID/dependency audit before any merge']
};
fs.writeFileSync(path.join(run, 'evidence.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, counts: report.counts, evidence: path.join(run, 'evidence.json'), log: path.join(run, 'tests.tap') }, null, 2));
process.exitCode = report.passed ? 0 : 1;
