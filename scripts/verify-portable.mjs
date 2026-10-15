// Structural/content verification works cross-platform; it does not execute Windows code.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), { path7za } = require('7zip-bin');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const artifact = path.join(root, `artifacts/windows-x64/WorldRenew-${version}-windows-x64-portable.exe`);
const packaged = path.join(root, 'dist/WorldRenew-win32-x64');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const temp = fs.mkdtempSync(path.join(root, 'work/portable-verify-'));
const digest = async file => {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
try {
  const header = Buffer.alloc(4096), fd = fs.openSync(artifact, 'r');
  try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
  assert.equal(header.toString('ascii', 0, 2), 'MZ');
  const pe = header.readUInt32LE(60); assert.ok(pe + 256 < header.length);
  assert.equal(header.toString('ascii', pe, pe + 4), 'PE\0\0');
  const optional = pe + 24, magic = header.readUInt16LE(optional);
  assert.ok([0x10b, 0x20b].includes(magic));
  const certificates = optional + (magic === 0x10b ? 96 : 112) + 4 * 8;
  assert.equal(header.readUInt32LE(certificates + 4), 0, 'Test launcher is expected to have no Authenticode signature.');
  const extraction = spawnSync(path7za, ['x', '-y', `-o${temp}`, artifact], { encoding: 'utf8', maxBuffer: 4 * 1024 ** 2 });
  assert.equal(extraction.status, 0, extraction.stderr || extraction.stdout);
  const files = fs.readdirSync(packaged, { recursive: true, withFileTypes: true }).filter(e => e.isFile());
  for (const entry of files) {
    const source = path.join(entry.parentPath, entry.name), relative = path.relative(packaged, source);
    assert.equal(await digest(path.join(temp, relative)), await digest(source), `Portable payload differs: ${relative}`);
  }
  const report = { passed: true, verification: 'PE structure and byte-identical embedded application files', unsigned: true, filesCompared: files.length, artifact: path.basename(artifact), sha256: await digest(artifact), host: `${process.platform}-${process.arch}`, windowsExecutionTested: false };
  fs.writeFileSync(path.join(root, 'artifacts/windows-x64/payload-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
