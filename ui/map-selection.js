// Selection is an index operation, independent of loaded terrain and volume/export limits.
export const chunkKey = (x, z) => `${x},${z}`;
export function applyChunkRange(current, chunks, a, b, mode = 'replace') {
  if (!['replace', 'add', 'remove'].includes(mode) || ![a.x,a.z,b.x,b.z].every(Number.isSafeInteger)) throw new Error('Choose whole chunk coordinates and a selection mode.');
  const next = mode === 'replace' ? new Set() : new Set(current);
  const minX=Math.min(a.x,b.x),maxX=Math.max(a.x,b.x),minZ=Math.min(a.z,b.z),maxZ=Math.max(a.z,b.z);
  // Iterate the bounded inspected index, never the possibly enormous rectangle.
  for (const c of chunks) if(c.x>=minX && c.x<=maxX && c.z>=minZ && c.z<=maxZ) {
    if(mode==='remove') next.delete(chunkKey(c.x,c.z)); else next.add(chunkKey(c.x,c.z));
  }
  return next;
}
export function selectionExtent(selection) {
  if(!selection.size)return null;
  const bounds={minX:Infinity,maxX:-Infinity,minZ:Infinity,maxZ:-Infinity};
  for(const id of selection){const [x,z]=id.split(',').map(Number);bounds.minX=Math.min(bounds.minX,x);bounds.maxX=Math.max(bounds.maxX,x);bounds.minZ=Math.min(bounds.minZ,z);bounds.maxZ=Math.max(bounds.maxZ,z);}
  return bounds;
}
