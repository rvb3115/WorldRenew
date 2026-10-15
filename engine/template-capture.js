import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { externalParent } from './build-archive.js';
import { createChunkReader } from './chunks.js';
import { requireThat } from './errors.js';
import { NBT_LIMITS } from './nbt.js';
import { readBounded, safePath } from './paths.js';
import { checkTemplateCancellation, writeTemplateStream } from './template-stream.js';
import { readWorldConfiguration } from './world-configuration.js';

const STORES = ['region', 'entities', 'poi'];
const MAX_SECTIONS = 4096;
const JOURNAL_LINE_LIMIT = 16 * 1024;
const changed = () => requireThat(false, 'ARCHIVE_CHANGED', 'Source storage changed during capture. Close Minecraft and retry.');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function abort(options) { checkTemplateCancellation(options); }

// Nanosecond ctime and inode identity catch replacement and edits even when a
// writer restores the original mtime. A missing optional store is an observation
// too: creating it while capture is running invalidates the capture.
function stamp(root, relative) {
  try {
    const value = fs.statSync(safePath(root, relative), { bigint: true });
    requireThat(value.isFile(), 'ARCHIVE_SOURCE_FILE', 'Template source records must be regular files.');
    return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function observe(root, paths) { return paths.map(relative => [relative, stamp(root, relative)]); }
function verify(root, observations, options) {
  for (const [relative, expected] of observations) {
    abort(options);
    if (stamp(root, relative) !== expected) changed();
  }
}
function sourcePaths(dimension, x, z) {
  return STORES.flatMap(store => {
    const folder = path.join(dimension.path === '.' ? '' : dimension.path, store);
    return [path.join(folder, `r.${Math.floor(x / 32)}.${Math.floor(z / 32)}.mca`), path.join(folder, `c.${x}.${z}.mcc`)];
  });
}
function append(fd, record) {
  const bytes = Buffer.from(JSON.stringify(record) + '\n');
  requireThat(bytes.length <= JOURNAL_LINE_LIMIT, 'ARCHIVE_JOURNAL', 'Source observation exceeds the journal record limit.');
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    requireThat(written > 0, 'ARCHIVE_JOURNAL', 'Could not write source observation journal.');
    offset += written;
  }
}
// Replay from one descriptor, never read the complete journal into memory.
function* journalRecords(fd) {
  const buffer = Buffer.alloc(64 * 1024), decoder = new StringDecoder('utf8');
  let position = 0, pending = '';
  for (;;) {
    const count = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (!count) break;
    position += count;
    pending += decoder.write(buffer.subarray(0, count));
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      requireThat(newline <= JOURNAL_LINE_LIMIT, 'ARCHIVE_JOURNAL', 'Source observation journal is damaged.');
      yield JSON.parse(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
    requireThat(Buffer.byteLength(pending) <= JOURNAL_LINE_LIMIT, 'ARCHIVE_JOURNAL', 'Source observation journal is damaged.');
  }
  requireThat(!pending.length, 'ARCHIVE_JOURNAL', 'Source observation journal is truncated.');
}

/**
 * Capture selected cells and byte-exact supporting NBT into a portable schema-2
 * file. Selection masks distinguish intentional air from excluded cells. Each
 * chunk gets its own bounded reader; total template size is not a read budget.
 *
 * Source worlds must be closed. The private disk journal rechecks all previously
 * read source files before the writer publishes its exclusive, verified file.
 * Source paths are used only in that temporary journal, never in the archive.
 */
export function captureTemplateStream(file, world, dimensionKey, selection, options = {}) {
  const { worlds = [], signal, onProgress = () => {} } = options;
  abort(options);
  requireThat(world?.root && world.metadata && Array.isArray(world.dimensions), 'ARCHIVE_WORLD', 'Choose an inspected source world.');
  const dimension = world.dimensions.find(value => value.key === dimensionKey);
  requireThat(dimension, 'ARCHIVE_DIMENSION', 'Choose a dimension in the source world.');
  requireThat(selection && typeof selection.iterateChunks === 'function' && selection.bounds && selection.blockCount > 0n, 'ARCHIVE_SELECTION', 'Select at least one block to capture.');
  // SparseSelection snapshots its box array when the iterator is requested.
  // Keep count and bounds from that same point, before progress hooks can edit it.
  const bounds = { ...selection.bounds }, selectedBlockCount = selection.blockCount;
  const selectedChunks = selection.iterateChunks({ signal });
  const protectedWorlds = [...worlds, world.root];
  const directory = externalParent(path.dirname(path.resolve(file)), protectedWorlds);
  const journal = path.join(directory, `.worldrenew-capture-${randomUUID()}.journal`);
  let journalFd;
  try {
    journalFd = fs.openSync(journal, 'wx+', 0o600);
    const metadataObservations = observe(world.root, ['level.dat', 'data/minecraft/world_gen_settings.dat']);
    const fingerprint = hash(readBounded(world.root, 'level.dat', NBT_LIMITS.compressed));
    requireThat(fingerprint === world.fingerprint, 'ARCHIVE_CHANGED', 'World metadata changed since inspection. Rescan before capturing.');
    const configuration = readWorldConfiguration(world.root, { fingerprintPacks: false });
    verify(world.root, metadataObservations, options);
    const header = {
      format: 'WorldRenew.build', schema: 2, createdAt: new Date().toISOString(),
      source: {
        name: world.metadata.name, version: world.metadata.version, dataVersion: world.metadata.dataVersion,
        dimensionId: dimension.id, dimensionKey, bounds, configuration: configuration.provenance
      }
    };
    function verifySource() {
      for (const record of journalRecords(journalFd)) verify(world.root, record.observations, options);
      verify(world.root, metadataObservations, options);
      requireThat(readWorldConfiguration(world.root, { fingerprintPacks: false }).digest === configuration.digest,
        'ARCHIVE_CHANGED', 'World metadata or generation configuration changed during capture.');
      verify(world.root, metadataObservations, options);
      abort(options);
    }
    function* chunks() {
      let captured = 0n, selected = 0n;
      for (const chunk of selectedChunks) {
        abort(options);
        onProgress({ phase: 'Capturing template', chunks: captured.toString(), selectedBlocks: selected.toString(), x: chunk.x, z: chunk.z });
        abort(options);
        const sections = [];
        for (const section of chunk.sections) {
          abort(options);
          requireThat(sections.length < MAX_SECTIONS, 'ARCHIVE_SECTIONS', 'A template chunk exceeds the 4096-section format safety limit.');
          requireThat(Buffer.isBuffer(section.mask) && section.mask.length === 512, 'ARCHIVE_MASK', 'Selection section masks must contain 4096 bits.');
          const mask = Buffer.from(section.mask);
          sections.push({ y: section.y, mask });
          let count = 0;
          for (const byte of mask) { let value = byte; while (value) { count++; value &= value - 1; } }
          selected += BigInt(count);
        }
        const observations = observe(world.root, sourcePaths(dimension, chunk.x, chunk.z));
        const reader = createChunkReader(world.root, dimension), records = {};
        for (const store of STORES) { abort(options); records[store] = reader.read(chunk.x, chunk.z, store)?.raw ?? null; }
        requireThat(records.region, 'ARCHIVE_UNKNOWN', 'Selection contains an absent terrain chunk. Unknown terrain cannot be captured as air.');
        reader.verifyStable();
        verify(world.root, observations, options);
        append(journalFd, { x: chunk.x, z: chunk.z, observations });
        captured++;
        yield { x: chunk.x, z: chunk.z, sections, records };
      }
      abort(options);
      requireThat(selected === selectedBlockCount, 'ARCHIVE_SELECTION_CHANGED', 'Selection changed during capture. Retry with a stable selection.');
      let verified = 0n;
      for (const record of journalRecords(journalFd)) {
        abort(options);
        onProgress({ phase: 'Verifying template source', chunks: (++verified).toString(), totalChunks: captured.toString(), x: record.x, z: record.z });
        verify(world.root, record.observations, options);
      }
      // Hooks may run caller code. Repeat silently after the last progress hook
      // so a hook cannot change an earlier, already-verified source unnoticed.
      verifySource();
    }
    // The generator does not finish until all observations verify. The writer
    // must consume it completely before publishing its output path.
    return writeTemplateStream(file, header, chunks(), {
      ...options, worlds: protectedWorlds,
      beforePublish() { options.beforePublish?.(); verifySource(); }
    });
  } finally {
    if (journalFd !== undefined) {
      try { fs.closeSync(journalFd); }
      finally { try { fs.unlinkSync(journal); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    }
  }
}
