import fs from 'node:fs';
import path from 'node:path';
import { requireThat } from './errors.js';

export function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export function canonicalWorld(folder) {
  requireThat(typeof folder === 'string' && folder.length > 0, 'PATH', 'Choose a world folder.');
  const root = fs.realpathSync(folder);
  requireThat(fs.statSync(root).isDirectory(), 'PATH', 'Choose a folder containing level.dat.');
  return root;
}
export function safePath(root, relative) {
  const target = path.resolve(root, relative);
  requireThat(isWithin(root, target), 'PATH_ESCAPE', 'Path escapes the world folder.');
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    requireThat(!stat.isSymbolicLink(), 'SYMLINK', `Symbolic links are not inspected: ${relative}`);
  }
  return target;
}
export function readBounded(root, relative, max) {
  const target = safePath(root, relative), stat = fs.statSync(target);
  requireThat(stat.isFile() && stat.size <= max, 'FILE_SIZE', `${relative} is not a regular file within the size limit.`);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const buffer = Buffer.alloc(stat.size);
    requireThat(fs.readSync(fd, buffer, 0, buffer.length, 0) === buffer.length, 'FILE_CHANGED', `${relative} changed while reading.`);
    const after = fs.fstatSync(fd);
    requireThat(after.size === stat.size && after.mtimeMs === stat.mtimeMs, 'FILE_CHANGED', `${relative} changed while reading.`);
    return buffer;
  } finally { fs.closeSync(fd); }
}
