import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireThat } from './errors.js';
import { readBounded, safePath } from './paths.js';
import { decodeBuildBytes, encodeBuild, externalParent } from './build-archive.js';
const MAX_FILE = 64 * 1024 * 1024;
export function templateFilename(name) {
  requireThat(typeof name === 'string' && name.length <= 256, 'TEMPLATE_NAME', 'Enter a template name of up to 256 characters.');
  let base = name.replace(/\.wrbuild$/i, '').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '-').trim().replace(/[. ]+$/g, '').slice(0, 100).replace(/[. ]+$/g, '');
  if (!base) base = 'Build';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = 'Build-' + base;
  return `${base}.wrbuild`;
}
export function ensureTemplateDirectory(directory, worlds = []) {
  let ancestor = path.resolve(directory);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  // Check before mkdir: even directory creation is forbidden inside a source save.
  externalParent(ancestor, worlds);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return externalParent(directory, worlds);
}
export function templatePath(directory, id) {
  requireThat(typeof id === 'string' && id.length <= 180 && /\.wrbuild$/i.test(id) && !/[\\/\x00-\x1f]/.test(id) && path.basename(id) === id, 'TEMPLATE_ID', 'Choose a file from the template library.');
  return safePath(directory, id);
}
function writeVerifiedBytes(directory, filename, bytes, checked, chooseUnique) {
  const temporary = path.join(directory, `.worldrenew-${randomUUID()}.partial`);
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    const saved = readBounded(directory, path.basename(temporary), MAX_FILE);
    requireThat(saved.equals(bytes), 'TEMPLATE_VERIFY', 'Template copy did not verify.');
    for (let suffix = 1; suffix <= 10000; suffix++) {
      const id = suffix === 1 ? filename : `${filename.slice(0, -8)} (${suffix}).wrbuild`, target = path.join(directory, id);
      try {
        fs.linkSync(temporary, target); // Atomic, exclusive publication: never replace a file.
        return { id, file: target, digest: checked.digest, summary: checked.summary, volume: checked.volume };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        requireThat(chooseUnique, 'TEMPLATE_EXISTS', 'That file already exists. Choose a different export filename; existing files are never overwritten.');
      }
    }
    throw new Error('Too many templates with that name. Choose a different name.');
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export function importTemplate(directory, source, worlds = []) {
  requireThat(typeof source === 'string' && source.length <= 4096 && /\.wrbuild$/i.test(source), 'TEMPLATE_FORMAT', 'Import one .wrbuild file.');
  const file = path.resolve(source), bytes = readBounded(path.dirname(file), path.basename(file), MAX_FILE);
  const checked = decodeBuildBytes(bytes); // Validate untrusted input before creating library files.
  const target = ensureTemplateDirectory(directory, worlds);
  return writeVerifiedBytes(target, templateFilename(path.basename(file)), bytes, checked, true);
}
export function saveTemplate(directory, name, archive, worlds = []) {
  const filename = templateFilename(name), bytes = encodeBuild(archive), checked = decodeBuildBytes(bytes);
  return writeVerifiedBytes(ensureTemplateDirectory(directory, worlds), filename, bytes, checked, true);
}
export function openTemplate(directory, id) {
  const file = templatePath(directory, id), checked = decodeBuildBytes(readBounded(directory, id, MAX_FILE));
  return { id, file, digest: checked.digest, summary: checked.summary, volume: checked.volume };
}
export function exportTemplate(source, destination, worlds = []) {
  requireThat(typeof destination === 'string' && /\.wrbuild$/i.test(destination), 'TEMPLATE_FORMAT', 'Use the .wrbuild filename extension.');
  const bytes = readBounded(path.dirname(source), path.basename(source), MAX_FILE), checked = decodeBuildBytes(bytes);
  const directory = externalParent(path.dirname(path.resolve(destination)), worlds);
  return writeVerifiedBytes(directory, path.basename(destination), bytes, checked, false);
}
export function listTemplates(directory, { offset = 0, limit = 50 } = {}, worlds = []) {
  requireThat(Number.isInteger(offset) && offset >= 0 && offset <= 10000 && Number.isInteger(limit) && limit >= 1 && limit <= 50, 'TEMPLATE_PAGE', 'Invalid library page.');
  const root = ensureTemplateDirectory(directory, worlds), files = [], warnings = [];
  // The directory is user-visible. Foreign or damaged files are listed, then fully
  // validated on open; never trust a sidecar index or decode an entire library at once.
  const handle = fs.opendirSync(root); let truncated = false, scanned = 0;
  try { for (let entry; (entry = handle.readSync());) {
    if (++scanned > 10000) { truncated = true; break; }
    if (!/\.wrbuild$/i.test(entry.name)) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) { if (warnings.length < 20) warnings.push(`Skipped non-regular file: ${entry.name}`); continue; }
    files.push(entry.name);
  } } finally { handle.closeSync(); }
  files.sort((a, b) => a.localeCompare(b));
  const items = files.slice(offset, offset + limit).map(id => {
    try { const stat = fs.statSync(templatePath(root, id)); return { id, name: id.slice(0, -8), bytes: stat.size, modifiedAt: stat.mtime.toISOString(), oversized: stat.size > MAX_FILE }; }
    catch (error) { return { id, name: id, error: error.message }; }
  });
  return { directory: root, items, total: files.length, offset, nextOffset: offset + limit < files.length ? offset + limit : null, truncated, warnings };
}
