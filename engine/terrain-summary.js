// Derived preview data only. Changing projection/color rules must bump this schema.
export const TERRAIN_SUMMARY_SCHEMA = 1;
export const SUMMARY_STATES = ['pending', 'ready', 'absent', 'unreadable', 'unsupported', 'incomplete'];
export function summarizeTerrain(tile) {
  let rgb = tile.status === 'unsupported' ? 0x71617e : tile.status === 'absent' ? 0x233b43 : 0xd98b9e;
  if (tile.status === 'ready') {
    let count = 0, r = 0, g = 0, b = 0;
    for (let i = 0; i < 256; i++) if (tile.ids[i]) { count++; r += tile.rgba[i*4]; g += tile.rgba[i*4+1]; b += tile.rgba[i*4+2]; }
    rgb = count ? (Math.round(r/count)<<16) | (Math.round(g/count)<<8) | Math.round(b/count) : 0x35515e;
  }
  const state = tile.code === 'CHUNK_STATUS' ? 'incomplete' : tile.status;
  return { state: SUMMARY_STATES.indexOf(state), rgb };
}
