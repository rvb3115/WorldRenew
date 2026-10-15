import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBlockWorld, state } from './transfer-fixtures.js';
import { inspectWorld } from '../engine/world.js';
import { captureBuildArchive, saveBuildFile, readBuildFile } from '../engine/build-archive.js';
import { importTemplate, saveTemplate, openTemplate, exportTemplate, listTemplates, templateFilename } from '../engine/template-library.js';
const bounds = { minX: 0, maxX: 3, minY: 0, maxY: 3, minZ: 0, maxZ: 3 };
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'worldrenew-library-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = makeBlockWorld(path.join(base, 'world'), { dataVersion: 5023, block: (x, y) => state(y === 0 ? 'stone' : x < 2 ? 'cave_air' : 'oak_stairs', x < 2 || y === 0 ? undefined : { facing: 'north', half: 'top', shape: 'straight', waterlogged: 'false' }) });
  const world = inspectWorld(source), archive = captureBuildArchive(world, world.dimensions[0].key, bounds);
  const file = path.join(base, 'House.wrbuild'); saveBuildFile(file, archive, [source]);
  return { base, source, archive, file, library: path.join(base, 'profile', 'templates') };
}
test('import copies exact bytes, preserves originals, and safely numbers duplicate names', t => {
  const f = fixture(t), bytes = fs.readFileSync(f.file), a = importTemplate(f.library, f.file), b = importTemplate(f.library, f.file);
  assert.equal(a.id, 'House.wrbuild'); assert.equal(b.id, 'House (2).wrbuild');
  for (const file of [a.file, b.file, f.file]) assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(listTemplates(f.library).total, 2);
});
test('local save and cross-device export/import work after removing source and old library', t => {
  const f = fixture(t), saved = saveTemplate(f.library, 'Underground room', f.archive, [f.source]);
  const exported = path.join(f.base, 'moved.wrbuild'); exportTemplate(saved.file, exported, [f.source]);
  assert.deepEqual(fs.readFileSync(exported), fs.readFileSync(saved.file));
  fs.renameSync(f.source, f.source + '-offline'); fs.renameSync(f.library, f.library + '-offline');
  const other = path.join(f.base, 'other-device', 'templates'), imported = importTemplate(other, exported), opened = openTemplate(other, imported.id);
  assert.deepEqual(opened.volume.voxels, saved.volume.voxels); assert.deepEqual(opened.volume.palette, saved.volume.palette);
  assert.equal(opened.volume.stats.air, 24); assert.ok(opened.volume.palette.some(s => s?.Name === 'minecraft:cave_air'));
  assert.equal(JSON.stringify(readBuildFile(exported).archive).includes(f.base), false, 'No absolute source path is required by the archive.');
});
test('unsafe filenames normalize portably; path traversal and symbolic links cannot open library content', t => {
  const f = fixture(t); importTemplate(f.library, f.file);
  assert.equal(templateFilename('CON'), 'Build-CON.wrbuild'); assert.equal(templateFilename('room<>:"/\\|?*. '), 'room---------.wrbuild');
  assert.throws(() => openTemplate(f.library, '../House.wrbuild'), { code: 'TEMPLATE_ID' });
  assert.throws(() => openTemplate(f.library, '..\\House.wrbuild'), { code: 'TEMPLATE_ID' });
  fs.symlinkSync(f.file, path.join(f.library, 'linked.wrbuild'));
  assert.throws(() => openTemplate(f.library, 'linked.wrbuild'), { code: 'SYMLINK' });
  assert.equal(listTemplates(f.library).warnings.length, 1);
});
test('invalid, damaged and oversized imports are rejected before creating a library', t => {
  const f = fixture(t); fs.writeFileSync(f.file, 'not an archive');
  assert.throws(() => importTemplate(f.library, f.file), { code: 'ARCHIVE_FORMAT' }); assert.equal(fs.existsSync(f.library), false);
  const huge = path.join(f.base, 'large.wrbuild'), fd = fs.openSync(huge, 'w'); fs.ftruncateSync(fd, 64 * 1024 * 1024 + 1); fs.closeSync(fd);
  assert.throws(() => importTemplate(f.library, huge), { code: 'FILE_SIZE' }); assert.equal(fs.existsSync(f.library), false);
});
test('export never overwrites, and saving/importing cannot create directories inside a world', t => {
  const f = fixture(t), original = fs.readFileSync(f.file);
  assert.throws(() => exportTemplate(f.file, f.file), { code: 'TEMPLATE_EXISTS' }); assert.deepEqual(fs.readFileSync(f.file), original);
  const forbidden = path.join(f.source, 'new-folder', 'templates');
  assert.throws(() => importTemplate(forbidden, f.file), { code: 'ARCHIVE_IN_WORLD' }); assert.equal(fs.existsSync(path.join(f.source, 'new-folder')), false);
  assert.throws(() => exportTemplate(f.file, path.join(f.source, 'template.wrbuild')), { code: 'ARCHIVE_IN_WORLD' });
});
test('library listing is paginated without trusting files or unvalidated metadata', t => {
  const f = fixture(t); fs.mkdirSync(f.library, { recursive: true });
  for (let i = 0; i < 55; i++) fs.writeFileSync(path.join(f.library, `untrusted-${i.toString().padStart(2,'0')}.wrbuild`), 'bad');
  const first = listTemplates(f.library); assert.equal(first.items.length, 50); assert.equal(first.nextOffset, 50);
  const second = listTemplates(f.library, { offset: 50 }); assert.equal(second.items.length, 5); assert.equal(second.nextOffset, null);
  assert.throws(() => openTemplate(f.library, first.items[0].id), { code: 'ARCHIVE_FORMAT' });
  assert.throws(() => listTemplates(f.library, { limit: 5000 }), { code: 'TEMPLATE_PAGE' });
});
