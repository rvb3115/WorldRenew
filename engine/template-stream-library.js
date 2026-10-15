import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { requireThat } from './errors.js';
import { externalParent } from './build-archive.js';
import { safePath } from './paths.js';
import { ensureTemplateDirectory, templateFilename, templatePath } from './template-library.js';
import { iterateTemplate, validateTemplateStream, writeTemplateStream } from './template-stream.js';

// A template's total size does not determine the memory used to copy it. The
// stream reader separately enforces limits on individual frames and records.
const COPY_BYTES = 1024 * 1024;

function checkCancelled(options) {
  requireThat(!options.signal?.aborted && !options.shouldCancel?.(), 'TEMPLATE_CANCELLED', 'Template operation was cancelled.');
}

function progress(options, phase, bytes, totalBytes) {
  checkCancelled(options);
  options.onProgress?.({ phase, bytes, totalBytes });
  checkCancelled(options);
}

function assertNotLink(file) {
  requireThat(!fs.lstatSync(file).isSymbolicLink(), 'SYMLINK', 'Symbolic links are not used for template files or library directories.');
}

function externalDirectory(directory, worlds) {
  assertNotLink(directory);
  return externalParent(directory, worlds);
}

function libraryDirectory(directory, worlds) {
  let ancestor = path.resolve(directory);
  while (!fs.existsSync(ancestor)) {
    // existsSync follows links; lstat also catches dangling links.
    try { assertNotLink(ancestor); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    ancestor = path.dirname(ancestor);
  }
  assertNotLink(ancestor);
  return ensureTemplateDirectory(directory, worlds);
}

function sourcePath(source, worlds) {
  requireThat(typeof source === 'string' && source.length > 0 && source.length <= 4096 && /\.wrbuild$/i.test(source), 'TEMPLATE_FORMAT', 'Choose one .wrbuild file.');
  const absolute = path.resolve(source), root = externalDirectory(path.dirname(absolute), worlds);
  return safePath(root, path.basename(absolute));
}

function sameFile(a, b) {
  return a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function snapshot(file) { return fs.lstatSync(file, { bigint: true }); }

function assertStable(file, fd, before) {
  let current;
  try { current = snapshot(file); } catch { requireThat(false, 'FILE_CHANGED', 'Template changed while it was being read.'); }
  requireThat(sameFile(before, fs.fstatSync(fd, { bigint: true })) && sameFile(before, current), 'FILE_CHANGED', 'Template changed while it was being read.');
}

function openSource(file) {
  const before = snapshot(file);
  requireThat(!before.isSymbolicLink(), 'SYMLINK', 'Symbolic links are not used for template files.');
  requireThat(before.isFile(), 'FILE_SIZE', 'Choose a regular template file.');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    assertStable(file, fd, before);
    return { fd, before };
  } catch (error) { fs.closeSync(fd); throw error; }
}

function metadata(id, file, checked) {
  return { id, file, header: checked.header, digest: checked.digest, summary: checked.summary };
}

function unlinkTemporary(file) {
  try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function publish(directory, filename, temporary, checked, chooseUnique, options, assertReady) {
  // Hard-link publication is atomic and exclusive, including when an existing
  // entry is a dangling symlink. No check-then-rename overwrite window exists.
  for (let suffix = 1n; ; suffix++) {
    checkCancelled(options);
    const id = suffix === 1n ? filename : `${filename.slice(0, -8)} (${suffix}).wrbuild`;
    const target = path.join(directory, id);
    assertReady();
    try {
      fs.linkSync(temporary, target);
      return metadata(id, target, checked);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      requireThat(chooseUnique, 'TEMPLATE_EXISTS', 'That file already exists. Choose a different export filename; existing files are never overwritten.');
    }
  }
}

function verifyAndPublish(directory, filename, temporary, digest, chooseUnique, options) {
  const { fd, before } = openSource(temporary);
  try {
    const checked = validateTemplateStream(temporary, options);
    requireThat(checked.digest === digest, 'TEMPLATE_VERIFY', 'Template copy did not verify.');
    progress(options, 'Publishing template', before.size.toString(), before.size.toString());
    return publish(directory, filename, temporary, checked, chooseUnique, options, () => assertStable(temporary, fd, before));
  } finally { fs.closeSync(fd); }
}

function copyVerified(source, directoryForCopy, filename, chooseUnique, options) {
  checkCancelled(options);
  const { fd, before } = openSource(source);
  let temporary;
  try {
    // Hold the original descriptor while validating. A replaced pathname or a
    // modified source fails either the stable-file checks or the byte digest.
    const checked = validateTemplateStream(source, options);
    checkCancelled(options);
    assertStable(source, fd, before);
    const directory = directoryForCopy();
    temporary = path.join(directory, `.worldrenew-${randomUUID()}.partial`);
    const out = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    const buffer = Buffer.allocUnsafe(COPY_BYTES), digest = createHash('sha256');
    let copied = 0n;
    try {
      progress(options, 'Copying template', copied.toString(), before.size.toString());
      while (copied < before.size) {
        checkCancelled(options);
        const remaining = before.size - copied;
        const count = fs.readSync(fd, buffer, 0, remaining < BigInt(buffer.length) ? Number(remaining) : buffer.length, null);
        requireThat(count > 0, 'FILE_CHANGED', 'Template changed while it was being copied.');
        digest.update(buffer.subarray(0, count));
        for (let written = 0; written < count;) {
          checkCancelled(options);
          const amount = fs.writeSync(out, buffer, written, count - written);
          requireThat(amount > 0, 'TEMPLATE_VERIFY', 'Template copy could not be completed.');
          written += amount;
        }
        copied += BigInt(count);
        progress(options, 'Copying template', copied.toString(), before.size.toString());
      }
      requireThat(copied === before.size && digest.digest('hex') === checked.digest, 'TEMPLATE_VERIFY', 'Template source changed or its copy did not verify.');
      assertStable(source, fd, before);
      fs.fsyncSync(out);
    } finally { fs.closeSync(out); }
    progress(options, 'Verifying template', copied.toString(), before.size.toString());
    assertStable(source, fd, before);
    return verifyAndPublish(directory, filename, temporary, checked.digest, chooseUnique, options);
  } finally {
    fs.closeSync(fd);
    if (temporary) unlinkTemporary(temporary);
  }
}

/** Import v1 or v2 without converting its bytes or retaining all chunks. */
export function importTemplateStream(directory, source, options = {}) {
  const file = sourcePath(source, options.worlds ?? []);
  return copyVerified(file, () => libraryDirectory(directory, options.worlds ?? []), templateFilename(path.basename(file)), true, options);
}

/** Save an iterable of sparse chunks directly into the persistent library. */
export function saveTemplateStream(directory, name, header, chunks, options = {}) {
  checkCancelled(options);
  const filename = templateFilename(name), root = libraryDirectory(directory, options.worlds ?? []);
  const temporary = path.join(root, `.worldrenew-${randomUUID()}.partial`);
  try {
    const written = writeTemplateStream(temporary, header, chunks, options);
    return verifyAndPublish(root, filename, temporary, written.digest, true, options);
  } finally { unlinkTemporary(temporary); }
}

/** Return verified metadata and a fresh iterator; never create a dense volume. */
export function openTemplateStream(directory, id, options = {}) {
  checkCancelled(options);
  const root = externalDirectory(directory, options.worlds ?? []), file = templatePath(root, id);
  const { fd, before } = openSource(file);
  let checked;
  try {
    checked = validateTemplateStream(file, options);
    checkCancelled(options);
    assertStable(file, fd, before);
  } finally { fs.closeSync(fd); }
  return {
    ...metadata(id, file, checked),
    *iterate(iterationOptions = {}) {
      const settings = { ...options, ...iterationOptions };
      checkCancelled(settings);
      requireThat(sameFile(before, snapshot(file)), 'FILE_CHANGED', 'Template changed since it was opened.');
      for (const event of iterateTemplate(file, settings)) {
        checkCancelled(settings);
        if (event.type === 'end') {
          requireThat(event.digest === checked.digest && sameFile(before, snapshot(file)), 'FILE_CHANGED', 'Template changed since it was opened.');
        }
        yield event;
      }
    },
  };
}

/** Export verified original bytes, never overwriting a destination entry. */
export function exportTemplateStream(source, destination, options = {}) {
  requireThat(typeof destination === 'string' && destination.length > 0 && destination.length <= 4096 && /\.wrbuild$/i.test(destination), 'TEMPLATE_FORMAT', 'Use the .wrbuild filename extension.');
  const file = sourcePath(source, options.worlds ?? []), absolute = path.resolve(destination);
  return copyVerified(file, () => externalDirectory(path.dirname(absolute), options.worlds ?? []), path.basename(absolute), false, options);
}

/** List filenames only. Template metadata remains untrusted until opened. */
export function listTemplatesStream(directory, { offset = 0, limit = 50, ...options } = {}) {
  requireThat(Number.isSafeInteger(offset) && offset >= 0 && Number.isInteger(limit) && limit >= 1 && limit <= 50, 'TEMPLATE_PAGE', 'Invalid library page.');
  checkCancelled(options);
  const root = libraryDirectory(directory, options.worlds ?? []), files = [], warnings = [];
  const handle = fs.opendirSync(root);
  let scanned = 0, truncated = false;
  try {
    for (let entry; (entry = handle.readSync());) {
      checkCancelled(options);
      if (++scanned > 10000) { truncated = true; break; }
      if (!/\.wrbuild$/i.test(entry.name)) continue;
      if (entry.isSymbolicLink() || !entry.isFile()) {
        if (warnings.length < 20) warnings.push(`Skipped non-regular file: ${entry.name}`);
      } else files.push(entry.name);
    }
  } finally { handle.closeSync(); }
  files.sort((a, b) => a.localeCompare(b));
  const items = files.slice(offset, offset + limit).map(id => {
    try {
      const stat = fs.statSync(templatePath(root, id));
      return { id, name: id.slice(0, -8), bytes: stat.size, modifiedAt: stat.mtime.toISOString() };
    } catch (error) { return { id, name: id, error: error.message }; }
  });
  return { directory: root, items, total: files.length, offset, nextOffset: offset + limit < files.length ? offset + limit : null, truncated, warnings };
}
