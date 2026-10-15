import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { nbt } from './fixtures.js';
import { makeBlockWorld, state } from './transfer-fixtures.js';
import { inspectWorld } from '../engine/world.js';
import { captureBuildArchive, saveBuildFile } from '../engine/build-archive.js';
import { writeTemplateStream, selectedTemplateBlocks } from '../engine/template-stream.js';
import { importTemplateStream, saveTemplateStream, openTemplateStream, exportTemplateStream, listTemplatesStream } from '../engine/template-stream-library.js';

const bounds = { minX: 0, maxX: 3, minY: 0, maxY: 3, minZ: 0, maxZ: 3 };

function fixture(t, schema = 2) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'worldrenew-stream-library-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = makeBlockWorld(path.join(base, 'generated-world'), {
    dataVersion: 5023,
    block: (x, y) => state(y === 0 ? 'stone' : x < 2 ? 'cave_air' : 'oak_stairs', x < 2 || y === 0 ? undefined : { facing: 'north', half: 'top', shape: 'straight', waterlogged: 'false' }),
  });
  const world = inspectWorld(source), archive = captureBuildArchive(world, world.dimensions[0].key, bounds);
  const header = { ...archive, schema: 2, extension: { owner: 'generated fixture', unknown: [1, 2, 3] } };
  delete header.records;
  const mask = Buffer.alloc(512);
  // Two separated cells, including intentional cave air, survive as one group.
  for (const i of [0, 256 + 16, 3 * 256 + 3 * 16 + 3]) mask[i >> 3] |= 1 << (i & 7);
  const chunk = {
    x: 0, z: 0,
    sections: [{ y: 0, mask, extension: { note: 'selection metadata' } }],
    records: Object.fromEntries(['region', 'entities', 'poi'].map(store => {
      const record = archive.records.find(record => record.store === store);
      return [store, record.nbt === null ? null : Buffer.from(record.nbt, 'base64')];
    })),
    extension: { future: ['preserved', 12] },
  };
  const file = path.join(base, 'House.wrbuild');
  if (schema === 1) saveBuildFile(file, archive, [source]);
  else writeTemplateStream(file, header, [chunk], { worlds: [source] });
  return { base, source, archive, file, header, chunk, library: path.join(base, 'profile', 'templates') };
}

function assertClean(directory, expected = []) {
  assert.deepEqual(fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [], [...expected].sort());
}

test('v1 import and export preserve every original byte and expose streaming metadata', t => {
  const f = fixture(t, 1), original = fs.readFileSync(f.file);
  const saved = importTemplateStream(f.library, f.file), exported = path.join(f.base, 'portable.wrbuild');
  exportTemplateStream(saved.file, exported);
  assert.deepEqual(fs.readFileSync(exported), original);
  assert.deepEqual(fs.readFileSync(f.file), original);
  const opened = openTemplateStream(f.library, saved.id), events = [...opened.iterate()];
  assert.equal(opened.header.legacySchema, 1);
  assert.equal(opened.summary.selectedBlocks, '64');
  assert.equal(opened.summary.air, '24');
  assert.equal(opened.volume, undefined);
  assert.equal(events[0].type, 'header');
  assert.equal(events.at(-1).digest, saved.digest);
  assert.deepEqual(events[1].chunk.records.region, f.chunk.records.region);
});

test('v2 library survives unavailable source worlds and preserves sparse air, states and unknown fields', t => {
  const f = fixture(t), saved = saveTemplateStream(f.library, 'Detached build', f.header, [f.chunk], { worlds: [f.source] });
  const portable = path.join(f.base, 'portable.wrbuild');
  exportTemplateStream(saved.file, portable, { worlds: [f.source] });
  fs.renameSync(f.source, f.source + '-offline');
  fs.renameSync(f.library, f.library + '-offline');
  const other = path.join(f.base, 'new-device', 'templates'), imported = importTemplateStream(other, portable);
  const opened = openTemplateStream(other, imported.id), chunks = [...opened.iterate()].filter(e => e.type === 'chunk');
  assert.equal(opened.summary.selectedBlocks, '3');
  assert.equal(opened.summary.air, '1');
  assert.equal(opened.volume, undefined);
  assert.deepEqual(opened.header.extension, f.header.extension);
  assert.deepEqual(chunks[0].chunk.extension, f.chunk.extension);
  assert.deepEqual(chunks[0].chunk.sections[0], f.chunk.sections[0]);
  assert.deepEqual(chunks[0].chunk.records, f.chunk.records);
  const cells = [...selectedTemplateBlocks(chunks[0].chunk)];
  assert.deepEqual(cells.map(cell => [cell.x, cell.y, cell.z]), [[0, 0, 0], [0, 1, 1], [3, 3, 3]]);
  assert.equal(cells[1].state.Name, 'minecraft:cave_air');
  assert.deepEqual(cells[2].state.Properties, { facing: 'north', half: 'top', shape: 'straight', waterlogged: 'false' });
  assert.deepEqual(fs.readFileSync(imported.file), fs.readFileSync(portable));
});

test('duplicate imports and saves use unique names; export never replaces existing entries', t => {
  const f = fixture(t), bytes = fs.readFileSync(f.file);
  const first = importTemplateStream(f.library, f.file), second = importTemplateStream(f.library, f.file);
  const third = saveTemplateStream(f.library, 'House', f.header, [f.chunk]);
  assert.equal(first.id, 'House.wrbuild');
  assert.equal(second.id, 'House (2).wrbuild');
  assert.equal(third.id, 'House (3).wrbuild');
  assert.throws(() => exportTemplateStream(first.file, f.file), { code: 'TEMPLATE_EXISTS' });
  assert.deepEqual(fs.readFileSync(f.file), bytes);
  const link = path.join(f.base, 'dangling.wrbuild');
  fs.symlinkSync(path.join(f.base, 'missing'), link);
  assert.throws(() => exportTemplateStream(first.file, link), { code: 'TEMPLATE_EXISTS' });
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.statSync(first.file).mode & 0o777, 0o600);
  assertClean(f.library, [first.id, second.id, third.id]);
});

test('malformed and corrupted imports are rejected before creating the library', t => {
  const f = fixture(t), bytes = fs.readFileSync(f.file);
  fs.writeFileSync(f.file, 'not a template');
  assert.throws(() => importTemplateStream(f.library, f.file));
  assert.equal(fs.existsSync(f.library), false);
  const damaged = Buffer.from(bytes); damaged[damaged.length - 2] ^= 1;
  fs.writeFileSync(f.file, damaged);
  assert.throws(() => importTemplateStream(f.library, f.file));
  assert.equal(fs.existsSync(f.library), false);
});

test('aborted imports do not create directories; cancellation during copying removes partial files', t => {
  const f = fixture(t), aborted = AbortSignal.abort();
  assert.throws(() => importTemplateStream(f.library, f.file, { signal: aborted }), { code: 'TEMPLATE_CANCELLED' });
  assert.equal(fs.existsSync(f.library), false);
  const controller = new AbortController();
  assert.throws(() => importTemplateStream(f.library, f.file, {
    signal: controller.signal,
    onProgress: progress => { if (progress.phase === 'Copying template' && BigInt(progress.bytes) > 0n) controller.abort(); },
  }), { code: 'TEMPLATE_CANCELLED' });
  assertClean(f.library);
  let cancel = false;
  assert.throws(() => importTemplateStream(f.library, f.file, {
    shouldCancel: () => cancel,
    onProgress: progress => { if (progress.phase === 'Copying template') cancel = true; },
  }), { code: 'TEMPLATE_CANCELLED' });
  assertClean(f.library);
});

test('cancelled saves clean both writer and library temporaries', t => {
  const f = fixture(t), controller = new AbortController();
  assert.throws(() => saveTemplateStream(f.library, 'cancelled', f.header, [f.chunk], {
    signal: controller.signal,
    onProgress: event => { if (event.phase === 'Writing template') controller.abort(); },
  }), { code: 'TEMPLATE_CANCELLED' });
  assertClean(f.library);
});

test('source replacement or mutation during copying cannot publish an unchecked template', t => {
  for (const mutation of ['replace', 'overwrite']) {
    const f = fixture(t);
    let changed = false;
    assert.throws(() => importTemplateStream(f.library, f.file, {
      onProgress: progress => {
        if (changed || progress.phase !== 'Copying template' || BigInt(progress.bytes) !== 0n) return;
        changed = true;
        if (mutation === 'replace') fs.renameSync(f.file, f.file + '.original');
        fs.writeFileSync(f.file, 'replacement bytes');
      },
    }));
    assert.equal(changed, true);
    assertClean(f.library);
  }
});

test('tampering with the private copy immediately before publication is detected', t => {
  const f = fixture(t);
  assert.throws(() => importTemplateStream(f.library, f.file, {
    onProgress: progress => {
      if (progress.phase === 'Publishing template') {
        const temporary = fs.readdirSync(f.library).find(name => name.endsWith('.partial'));
        fs.writeFileSync(path.join(f.library, temporary), 'damaged copy');
      }
    },
  }), { code: 'FILE_CHANGED' });
  assertClean(f.library);
});

test('library operations reject traversal, source links, library links and paths inside saves', t => {
  const f = fixture(t), saved = importTemplateStream(f.library, f.file);
  assert.throws(() => openTemplateStream(f.library, '../House.wrbuild'), { code: 'TEMPLATE_ID' });
  assert.throws(() => openTemplateStream(f.library, '..\\House.wrbuild'), { code: 'TEMPLATE_ID' });
  const linked = path.join(f.library, 'linked.wrbuild'); fs.symlinkSync(f.file, linked);
  assert.throws(() => importTemplateStream(f.library, linked), { code: 'SYMLINK' });
  assert.throws(() => openTemplateStream(f.library, 'linked.wrbuild'), { code: 'SYMLINK' });
  assert.throws(() => exportTemplateStream(linked, path.join(f.base, 'export.wrbuild')), { code: 'SYMLINK' });
  const alias = path.join(f.base, 'linked-library'); fs.symlinkSync(f.library, alias);
  assert.throws(() => importTemplateStream(alias, f.file), { code: 'SYMLINK' });
  assert.throws(() => openTemplateStream(alias, saved.id), { code: 'SYMLINK' });
  const forbidden = path.join(f.source, 'new', 'templates');
  assert.throws(() => importTemplateStream(forbidden, f.file), { code: 'ARCHIVE_IN_WORLD' });
  assert.throws(() => saveTemplateStream(forbidden, 'build', f.header, [f.chunk]), { code: 'ARCHIVE_IN_WORLD' });
  assert.throws(() => exportTemplateStream(saved.file, path.join(f.source, 'build.wrbuild')), { code: 'ARCHIVE_IN_WORLD' });
  assert.equal(fs.existsSync(path.join(f.source, 'new')), false);
  const insideSave = path.join(f.source, 'read.wrbuild'); fs.copyFileSync(f.file, insideSave);
  assert.throws(() => importTemplateStream(f.library, insideSave), { code: 'ARCHIVE_IN_WORLD' });
});

test('opened metadata does not authorize a later changed file and iterators honour cancellation', t => {
  const f = fixture(t), saved = importTemplateStream(f.library, f.file), opened = openTemplateStream(f.library, saved.id);
  assert.throws(() => [...opened.iterate({ signal: AbortSignal.abort() })], { code: 'TEMPLATE_CANCELLED' });
  fs.renameSync(saved.file, saved.file + '.original'); fs.copyFileSync(f.file, saved.file);
  assert.throws(() => [...opened.iterate()], { code: 'FILE_CHANGED' });
});

test('listing is paginated, skips symlinks, and does not impose a 64 MiB template-size label', t => {
  const f = fixture(t); fs.mkdirSync(f.library, { recursive: true });
  for (let i = 0; i < 55; i++) fs.writeFileSync(path.join(f.library, `item-${String(i).padStart(2, '0')}.wrbuild`), 'unvalidated');
  const huge = path.join(f.library, 'item-00.wrbuild'), fd = fs.openSync(huge, 'w');
  fs.ftruncateSync(fd, 64 * 1024 * 1024 + 1); fs.closeSync(fd);
  fs.symlinkSync(f.file, path.join(f.library, 'linked.wrbuild'));
  const first = listTemplatesStream(f.library), second = listTemplatesStream(f.library, { offset: 50 });
  assert.equal(first.total, 55);
  assert.equal(first.items.length, 50);
  assert.equal(first.nextOffset, 50);
  assert.equal(first.warnings.length, 1);
  assert.equal(first.items[0].bytes, 64 * 1024 * 1024 + 1);
  assert.equal(Object.hasOwn(first.items[0], 'oversized'), false);
  assert.equal(second.items.length, 5);
  assert.equal(second.nextOffset, null);
  assert.throws(() => listTemplatesStream(f.library, { limit: 1000 }), { code: 'TEMPLATE_PAGE' });
});

test('multi-megabyte imports copy in bounded batches, report progress, and preserve opaque raw data', t => {
  const f = fixture(t);
  const chunk = { ...f.chunk, records: { ...f.chunk.records, poi: nbt({
    DataVersion: [3, 5023], Sections: [10, {}],
    FutureA: [7, randomBytes(800000)], FutureB: [7, randomBytes(800000)], FutureC: [7, randomBytes(800000)],
  }) } };
  const large = path.join(f.base, 'Large.wrbuild');
  const original = writeTemplateStream(large, f.header, [chunk]);
  const size = fs.statSync(large).size;
  assert.ok(size > 2 * 1024 * 1024);
  const copies = [];
  const imported = importTemplateStream(f.library, large, {
    onProgress: event => { if (event.phase === 'Copying template') copies.push(event); },
  });
  assert.equal(imported.digest, original.digest);
  assert.equal(copies[0].bytes, '0');
  assert.equal(copies.at(-1).bytes, String(size));
  assert.ok(copies.length >= 4);
  for (let i = 1; i < copies.length; i++) {
    assert.ok(BigInt(copies[i].bytes) - BigInt(copies[i - 1].bytes) <= 1024n * 1024n);
    assert.equal(copies[i].totalBytes, String(size));
  }
  const opened = openTemplateStream(f.library, imported.id);
  const decoded = [...opened.iterate()].find(event => event.type === 'chunk').chunk;
  assert.deepEqual(decoded.records.poi, chunk.records.poi);
  const budgetLibrary = path.join(f.base, 'budget-library');
  assert.throws(() => importTemplateStream(budgetLibrary, large, { maxFileBytes: 100 }), { code: 'TEMPLATE_BUDGET' });
  assert.equal(fs.existsSync(budgetLibrary), false);
});
